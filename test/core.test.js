import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import remoteHandler from "../api/mcp.js";
import { credentialsPath, loadCredentials, saveCredentials } from "../src/config.js";
import { buildMcpUrl, deployProject } from "../src/deploy.js";
import { TOOLS, validateToolCall } from "../src/fcps.js";
import { createServer } from "../src/server.js";
import { mergeClientConfig } from "../src/setup.js";

test("exports the complete Schoology and StudentVUE tool set", () => {
  assert.equal(TOOLS.length, 11);
  assert.ok(TOOLS.some((tool) => tool.name === "schoology_read_document"));
  assert.ok(TOOLS.some((tool) => tool.name === "studentvue_get_grades"));
});

test("completes an MCP handshake and lists tools", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  assert.equal(result.tools.length, 11);
  assert.ok(result.tools.some((tool) => tool.name === "studentvue_get_assignments"));
  await client.close();
  await server.close();
});

test("validates untrusted tool arguments", () => {
  assert.deepEqual(validateToolCall("schoology_get_upcoming_events", {}), { days: 30 });
  assert.deepEqual(validateToolCall("schoology_get_materials", { sectionId: "12345" }), { sectionId: "12345" });
  assert.throws(
    () => validateToolCall("schoology_get_materials", { sectionId: "../../profile" }),
    /only digits/,
  );
  assert.throws(
    () => validateToolCall("schoology_get_upcoming_events", { days: 1000 }),
    /1 to 180/,
  );
  assert.throws(
    () => validateToolCall("schoology_get_calendar", { start: "tomorrow" }),
    /YYYY-MM-DD/,
  );
  assert.throws(
    () => validateToolCall("schoology_get_calendar", { start: "2026-02-31" }),
    /YYYY-MM-DD/,
  );
  assert.throws(
    () => validateToolCall("studentvue_get_grades", { injected: true }),
    /Unexpected tool argument/,
  );
});

test("saves credentials outside the repository and reads them back", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "fcps-school-mcp-test-"));
  process.env.FCPS_SCHOOL_MCP_CONFIG_DIR = configDirectory;
  delete process.env.SCHOOLOGY_USERNAME;
  delete process.env.SCHOOLOGY_PASSWORD;

  const sampleValue = ["test", "value", "only"].join("-");
  await saveCredentials("student", sampleValue);
  const loaded = await loadCredentials();
  assert.equal(loaded.username, "student");
  assert.equal(loaded.password, sampleValue);
  assert.equal(credentialsPath(), join(configDirectory, "credentials.json"));
  if (process.platform !== "win32") {
    assert.equal((await stat(credentialsPath())).mode & 0o777, 0o600);
  }
});

test("merges MCP config without removing existing servers", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "fcps-client-test-"));
  const path = join(configDirectory, "mcp.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify({
    theme: "dark",
    mcpServers: { existing: { command: "existing-server" } },
  })));

  await mergeClientConfig(path);
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(config.theme, "dark");
  assert.equal(config.mcpServers.existing.command, "existing-server");
  assert.ok(config.mcpServers["fcps-school"]);
  assert.ok(config.mcpServers["fcps-school"].args.includes("fcps-school-mcp"));
});

test("deploys credentials as Vercel secrets without putting them in arguments", async () => {
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args, options });
    return args[0] === "deploy" ? "https://fcps-school-example.vercel.app" : "";
  };
  const values = {
    username: "student-user",
    password: ["example", "password", "only"].join("-"),
    secret: ["example", "url", "secret"].join("-"),
  };

  const url = await deployProject({
    directory: "/temporary/project",
    projectName: "fcps-school-mcp-example",
    ...values,
    runner,
  });

  assert.equal(url, buildMcpUrl("https://fcps-school-example.vercel.app", values.secret));
  assert.deepEqual(calls[0].args, ["link", "--yes", "--project", "fcps-school-mcp-example"]);
  assert.deepEqual(calls.slice(1, 4).map((call) => call.args), [
    ["env", "add", "SCHOOLOGY_USERNAME", "production", "--sensitive"],
    ["env", "add", "SCHOOLOGY_PASSWORD", "production", "--sensitive"],
    ["env", "add", "MCP_SECRET", "production", "--sensitive"],
  ]);
  assert.deepEqual(calls.slice(1, 4).map((call) => call.options.input), [
    values.username,
    values.password,
    values.secret,
  ]);
  const commandArguments = calls.flatMap((call) => call.args).join(" ");
  assert.ok(!commandArguments.includes(values.username));
  assert.ok(!commandArguments.includes(values.password));
  assert.ok(!commandArguments.includes(values.secret));
});

test("serves the complete tool list over authenticated Streamable HTTP", async () => {
  const previousSecret = process.env.MCP_SECRET;
  process.env.MCP_SECRET = "test-mcp-url-secret";
  const httpServer = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (chunks.length) request.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    await remoteHandler(request, response);
  });
  await new Promise((resolvePromise) => httpServer.listen(0, "127.0.0.1", resolvePromise));
  const { port } = httpServer.address();
  const endpoint = `http://127.0.0.1:${port}/api/mcp?key=test-mcp-url-secret`;
  const post = (body) => fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

  try {
    const blocked = await fetch(`http://127.0.0.1:${port}/api/mcp?key=wrong`);
    assert.equal(blocked.status, 404);

    const initialized = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    assert.equal(initialized.status, 200);
    assert.equal((await initialized.json()).result.serverInfo.name, "fcps-school");

    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).result.tools.length, 11);
  } finally {
    await new Promise((resolvePromise) => httpServer.close(resolvePromise));
    if (previousSecret == null) delete process.env.MCP_SECRET;
    else process.env.MCP_SECRET = previousSecret;
  }
});

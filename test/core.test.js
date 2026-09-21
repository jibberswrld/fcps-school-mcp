import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import remoteHandler from "../api/mcp.js";
import { credentialsPath, loadCredentials, loadIonCredentials } from "../src/config.js";
import { buildMcpUrl, deployProject } from "../src/deploy.js";
import { TOOLS, validateToolCall } from "../src/fcps.js";
import { ION_TOOLS, ionStatus, validateIonToolCall } from "../src/ion.js";
import { createServer } from "../src/server.js";
import { configureLocal, mergeClientConfig } from "../src/setup.js";

test("exports the complete Schoology and StudentVUE tool set", () => {
  assert.equal(TOOLS.length, 11);
  assert.ok(TOOLS.some((tool) => tool.name === "schoology_read_document"));
  assert.ok(TOOLS.some((tool) => tool.name === "studentvue_get_grades"));
});

test("exports the Ion tool set with a signup tool", () => {
  assert.equal(ION_TOOLS.length, 8);
  assert.ok(ION_TOOLS.every((tool) => tool.name.startsWith("ion_")));
  assert.ok(ION_TOOLS.some((tool) => tool.name === "ion_signup_eighth_period"));
  assert.ok(ION_TOOLS.every((tool) => tool.inputSchema.additionalProperties === false));
});

async function listTools(options) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  await client.close();
  await server.close();
  return result.tools;
}

test("completes an MCP handshake and lists FCPS tools plus the login check", async () => {
  const tools = await listTools();
  assert.equal(tools.length, 12);
  assert.ok(tools.some((tool) => tool.name === "studentvue_get_assignments"));
  assert.ok(tools.some((tool) => tool.name === "school_check_login"));
  assert.ok(!tools.some((tool) => tool.name.startsWith("ion_")));
});

test("lists Ion tools only when Ion is configured", async () => {
  const tools = await listTools({ ion: true });
  assert.equal(tools.length, 20);
  assert.ok(tools.some((tool) => tool.name === "ion_get_block_activities"));
});

test("validates untrusted Ion tool arguments", () => {
  assert.throws(() => validateIonToolCall("ion_get_profile", { injected: true }), /Unexpected tool argument/);
  assert.throws(() => validateIonToolCall("ion_get_block_activities", { blockId: "../x" }), /digits/);
  assert.throws(() => validateIonToolCall("ion_get_schedule", { date: "2026-02-31" }), /YYYY-MM-DD/);
  assert.throws(() => validateIonToolCall("ion_signup_eighth_period", {}), /scheduledActivityId|blockId/);
  assert.throws(() => validateIonToolCall("nope", {}), /Unknown tool/);
});

test("reports Ion as unconfigured without credentials instead of throwing", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "fcps-ion-status-"));
  process.env.FCPS_SCHOOL_MCP_CONFIG_DIR = configDirectory;
  delete process.env.ION_USERNAME;
  delete process.env.ION_PASSWORD;
  const status = await ionStatus();
  assert.equal(status.configured, false);
  assert.equal(status.authenticated, false);
});

test("describes submission status on the assignments tool", () => {
  const tool = TOOLS.find((item) => item.name === "schoology_get_assignments");
  assert.match(tool.description, /submission status/);
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

test("local setup saves credentials outside the repository and reads them back", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "fcps-school-mcp-test-"));
  process.env.FCPS_SCHOOL_MCP_CONFIG_DIR = configDirectory;
  delete process.env.SCHOOLOGY_USERNAME;
  delete process.env.SCHOOLOGY_PASSWORD;

  delete process.env.ION_USERNAME;
  delete process.env.ION_PASSWORD;

  const sampleValue = ["test", "value", "only"].join("-");
  await configureLocal("student", sampleValue, []);
  const loaded = await loadCredentials();
  assert.equal(loaded.username, "student");
  assert.equal(loaded.password, sampleValue);
  assert.equal(credentialsPath(), join(configDirectory, "credentials.json"));
  await assert.rejects(loadIonCredentials(), /Ion credentials are not configured/);

  await configureLocal("student", sampleValue, [], { username: "2029student", password: sampleValue });
  const ion = await loadIonCredentials();
  assert.equal(ion.username, "2029student");
  assert.equal(ion.password, sampleValue);
  assert.equal((await loadCredentials()).username, "student");
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
    return args[0] === "deploy" ? JSON.stringify({ url: "https://fcps-school-example.vercel.app" }) : "";
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
  assert.deepEqual(calls[4].args, ["deploy", "--prod", "--yes", "--json"]);
  const commandArguments = calls.flatMap((call) => call.args).join(" ");
  assert.ok(!commandArguments.includes(values.username));
  assert.ok(!commandArguments.includes(values.password));
  assert.ok(!commandArguments.includes(values.secret));

  calls.length = 0;
  await deployProject({
    directory: "/temporary/project",
    projectName: "fcps-school-mcp-example",
    ...values,
    ion: { username: "2029student", password: ["ion", "password", "only"].join("-") },
    runner,
  });
  assert.deepEqual(calls.slice(4, 6).map((call) => call.args), [
    ["env", "add", "ION_USERNAME", "production", "--sensitive"],
    ["env", "add", "ION_PASSWORD", "production", "--sensitive"],
  ]);
  assert.equal(calls[5].options.input, ["ion", "password", "only"].join("-"));
  assert.deepEqual(calls[6].args, ["deploy", "--prod", "--yes", "--json"]);
});

test("serves the complete tool list over authenticated Streamable HTTP", async () => {
  const previousSecret = process.env.MCP_SECRET;
  process.env.MCP_SECRET = "test-mcp-url-secret";
  process.env.FCPS_SCHOOL_MCP_CONFIG_DIR = await mkdtemp(join(tmpdir(), "fcps-remote-test-"));
  delete process.env.ION_USERNAME;
  delete process.env.ION_PASSWORD;
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
  const readMcpResponse = async (response) => {
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : text);
  };

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
    assert.equal((await readMcpResponse(initialized)).result.serverInfo.name, "fcps-school");

    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(listed.status, 200);
    assert.equal((await readMcpResponse(listed)).result.tools.length, 12);

    process.env.ION_USERNAME = "2029student";
    process.env.ION_PASSWORD = ["ion", "test", "only"].join("-");
    const withIon = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.equal((await readMcpResponse(withIon)).result.tools.length, 20);
  } finally {
    delete process.env.ION_USERNAME;
    delete process.env.ION_PASSWORD;
    await new Promise((resolvePromise) => httpServer.close(resolvePromise));
    if (previousSecret == null) delete process.env.MCP_SECRET;
    else process.env.MCP_SECRET = previousSecret;
  }
});

test("MCP_SECRET accepts a comma-separated list of per-client keys", async () => {
  const { allowedSecrets, secretsMatch } = await import("../api/mcp.js");
  assert.deepEqual(allowedSecrets(" chatgpt-key, heyclicky-key ,"), ["chatgpt-key", "heyclicky-key"]);
  assert.equal(secretsMatch("chatgpt-key", "chatgpt-key,heyclicky-key"), true);
  assert.equal(secretsMatch("heyclicky-key", "chatgpt-key,heyclicky-key"), true);
  assert.equal(secretsMatch("chatgpt-key,heyclicky-key", "chatgpt-key,heyclicky-key"), false);
  assert.equal(secretsMatch("wrong", "chatgpt-key,heyclicky-key"), false);
  assert.equal(secretsMatch("only-key", "only-key"), true);
  assert.equal(secretsMatch(undefined, "only-key"), false);
  assert.equal(secretsMatch("", ""), false);
});

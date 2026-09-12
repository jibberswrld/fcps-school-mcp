import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { credentialsPath, loadCredentials, saveCredentials } from "../src/config.js";
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

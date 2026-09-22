import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import { hasIonCredentials } from "../src/config.js";
import { createServer } from "../src/mcp-server.js";

export const config = { maxDuration: 60 };

function suppliedSecret(request) {
  const queryValue = request.query?.key ?? request.query?.k;
  if (Array.isArray(queryValue)) return queryValue[0];
  if (queryValue != null) return String(queryValue);
  return new URL(request.url, "http://localhost").searchParams.get("key")
    ?? new URL(request.url, "http://localhost").searchParams.get("k");
}

function secretsMatch(provided, expected) {
  const providedBytes = Buffer.from(provided ?? "");
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type, mcp-protocol-version, mcp-session-id");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  const secret = process.env.MCP_SECRET;
  if (!secret) {
    response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "MCP_SECRET is not configured" }));
    return;
  }
  if (!secretsMatch(suppliedSecret(request), secret)) {
    response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }

  if (request.method === "GET" && !String(request.headers.accept ?? "").includes("text/event-stream")) {
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, service: "fcps-school-mcp" }));
    return;
  }

  const server = createServer({ ion: await hasIonCredentials() });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  response.on("close", () => {
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      }));
    }
    console.error("MCP request failed:", error instanceof Error ? error.message : String(error));
  }
}

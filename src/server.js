import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, TOOLS } from "./fcps.js";

export function createServer() {
  const server = new Server(
    { name: "fcps-school", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Use Schoology for courses, materials, events, and updates. Use StudentVUE for official grades and assignment scores.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return { content: await callTool(request.params.name, request.params.arguments ?? {}) };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startServer() {
  await createServer().connect(new StdioServerTransport());
}

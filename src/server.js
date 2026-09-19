import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { hasIonCredentials } from "./config.js";
import { callTool, fcpsStatus, TOOLS } from "./fcps.js";
import { callIonTool, ION_TOOLS, ionStatus } from "./ion.js";

export const VERSION = "1.2.0";

const STATUS_TOOL = {
  name: "school_check_login",
  description: "Test the FCPS (Schoology, StudentVUE) and, when configured, TJHSST Ion logins and report exactly why any of them fails. Use this first when another tool reports a login problem.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
};

async function checkLogin() {
  const [fcps, ion] = await Promise.all([fcpsStatus(), ionStatus()]);
  return [{ type: "text", text: JSON.stringify({ ...fcps, ion }, null, 2) }];
}

export function createServer({ ion = false } = {}) {
  const tools = [...TOOLS, ...(ion ? ION_TOOLS : []), STATUS_TOOL];
  const server = new Server(
    { name: "fcps-school", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Use Schoology for courses, materials, events, and updates. Use StudentVUE for official grades."
        + (ion ? " Use Ion (the TJHSST intranet) for the bell schedule, school announcements, eighth period blocks and activities, and eighth period signups." : "")
        + " If a tool reports a login problem, call school_check_login before retrying.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      if (name === STATUS_TOOL.name) return { content: await checkLogin() };
      if (name.startsWith("ion_")) {
        if (!ion) throw new Error("Ion is not configured on this server. Re-run setup and answer yes to the TJHSST question.");
        return { content: await callIonTool(name, args) };
      }
      return { content: await callTool(name, args) };
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
  await createServer({ ion: await hasIonCredentials() }).connect(new StdioServerTransport());
}

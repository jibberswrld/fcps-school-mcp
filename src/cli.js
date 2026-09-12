#!/usr/bin/env node

import { runDeploy } from "./deploy.js";
import { runSetup } from "./setup.js";
import { startServer } from "./server.js";

const command = process.argv[2];

if (command === "deploy") {
  await runDeploy();
} else if (command === "setup") {
  await runSetup();
} else if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(`fcps-school-mcp\n\nCommands:\n  deploy   Deploy a private copy to Vercel for ChatGPT\n  setup    Save credentials and configure detected desktop clients\n  help     Show this help\n\nWith no command, starts the MCP server over stdio.\n`);
} else if (command) {
  process.stderr.write(`Unknown command: ${command}\nRun fcps-school-mcp --help for usage.\n`);
  process.exitCode = 1;
} else {
  await startServer();
}

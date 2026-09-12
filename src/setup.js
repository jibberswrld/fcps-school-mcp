import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { saveCredentials } from "./config.js";

const PACKAGE_SPEC = "https://github.com/jibberswrld/fcps-school-mcp/archive/refs/tags/v1.0.0.tar.gz";
const SERVER_NAME = "fcps-school";

function commandConfig() {
  const args = ["--yes", `--package=${PACKAGE_SPEC}`, "fcps-school-mcp"];
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "npx", ...args] };
  }
  return { command: "npx", args };
}

function candidates() {
  const home = homedir();
  const appData = process.env.APPDATA;
  const paths = [];

  if (process.platform === "darwin") {
    paths.push({ name: "Claude Desktop", path: join(home, "Library/Application Support/Claude/claude_desktop_config.json") });
  } else if (process.platform === "win32" && appData) {
    paths.push({ name: "Claude Desktop", path: join(appData, "Claude/claude_desktop_config.json") });
  } else {
    paths.push({ name: "Claude Desktop", path: join(home, ".config/Claude/claude_desktop_config.json") });
  }

  paths.push(
    { name: "Cursor", path: join(home, ".cursor/mcp.json") },
    { name: "Windsurf", path: join(home, ".codeium/windsurf/mcp_config.json") },
  );
  return paths;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function parentExists(path) {
  return exists(dirname(path));
}

export async function mergeClientConfig(path) {
  let config = {};
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Refusing to overwrite invalid JSON at ${path}: ${error.message}`);
    }
  }
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new Error(`Refusing to overwrite unexpected config at ${path}.`);
  }

  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object"
    ? config.mcpServers
    : {};
  config.mcpServers[SERVER_NAME] = commandConfig();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function hiddenQuestion(prompt) {
  if (!stdin.isTTY || !stdin.setRawMode) {
    throw new Error("Setup needs an interactive terminal. You can use SCHOOLOGY_USERNAME and SCHOOLOGY_PASSWORD instead.");
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  try {
    for await (const chunk of stdin) {
      for (const character of chunk) {
        if (character === "\u0003") throw new Error("Setup cancelled.");
        if (character === "\r" || character === "\n") {
          stdout.write("\n");
          return value;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  return value;
}

export async function runSetup() {
  stdout.write("\nFCPS School MCP setup\n\nCredentials stay on this computer and are only sent to official FCPS login services.\n\n");
  const reader = createInterface({ input: stdin, output: stdout });
  const username = (await reader.question("FCPS username: ")).trim();
  reader.close();
  const password = await hiddenQuestion("FCPS password: ");
  const savedAt = await saveCredentials(username, password);

  const detected = [];
  for (const client of candidates()) {
    if (await parentExists(client.path)) {
      await mergeClientConfig(client.path);
      detected.push(client.name);
    }
  }

  stdout.write(`\nSaved credentials locally at ${savedAt}\n`);
  if (detected.length) {
    stdout.write(`Configured: ${detected.join(", ")}\nRestart ${detected.length === 1 ? "the app" : "those apps"} to use the MCP.\n\n`);
  } else {
    stdout.write("No supported desktop client was detected. Add this MCP server command to your client:\n\n");
    stdout.write(`${JSON.stringify(commandConfig(), null, 2)}\n\n`);
  }
}

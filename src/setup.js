import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { saveCredentials } from "./config.js";

const PACKAGE_SPEC = "https://github.com/jibberswrld/fcps-school-mcp/archive/refs/tags/v1.2.0.tar.gz";
const SERVER_NAME = "fcps-school";

function commandConfig() {
  const args = ["--yes", "--allow-remote=all", "--ignore-scripts", `--package=${PACKAGE_SPEC}`, "fcps-school-mcp"];
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

export async function hiddenQuestion(prompt, input = stdin, output = stdout) {
  if (!input.isTTY || !input.setRawMode) {
    throw new Error("This command needs an interactive terminal.");
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      try {
        input.setRawMode(false);
      } catch {}
      input.pause();
    };

    function onData(chunk) {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Command cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    input.on("data", onData);
    input.on("error", onError);
  });
}

export async function configureLocal(username, password, availableClients = candidates(), ion = null) {
  const savedAt = await saveCredentials(username, password, ion);
  const detected = [];
  for (const client of availableClients) {
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

  return { savedAt, detected };
}

export async function askCredentials(input = stdin, output = stdout) {
  const reader = createInterface({ input, output });
  const username = (await reader.question("FCPS username: ")).trim();
  reader.close();
  const password = await hiddenQuestion("FCPS password: ", input, output);
  if (!username || !password) throw new Error("Both username and password are required.");

  const tjReader = createInterface({ input, output });
  const answer = (await tjReader.question("\nAre you a TJHSST student? Ion (the TJ intranet) adds the bell schedule, announcements, and eighth period signups. [y/N]: ")).trim().toLowerCase();
  let ion = null;
  if (answer === "y" || answer === "yes") {
    const ionUsername = (await tjReader.question("Ion username: ")).trim();
    tjReader.close();
    const ionPassword = await hiddenQuestion("Ion password: ", input, output);
    if (!ionUsername || !ionPassword) throw new Error("Both Ion username and password are required.");
    ion = { username: ionUsername, password: ionPassword };
  } else {
    tjReader.close();
  }
  return { username, password, ion };
}

export async function runSetup() {
  stdout.write("\nFCPS School MCP setup\n\nCredentials stay on this computer and are only sent to the official FCPS and TJHSST Ion login services.\n\n");
  const { username, password, ion } = await askCredentials();
  await configureLocal(username, password, candidates(), ion);
}

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function configRoot() {
  if (process.env.FCPS_SCHOOL_MCP_CONFIG_DIR) {
    return process.env.FCPS_SCHOOL_MCP_CONFIG_DIR;
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "fcps-school-mcp");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fcps-school-mcp");
}

export function credentialsPath() {
  return join(configRoot(), "credentials.json");
}

function validCredentials(value) {
  return value && typeof value.username === "string" && value.username.trim()
    && typeof value.password === "string" && value.password;
}

export async function loadCredentials() {
  const fromEnvironment = {
    username: process.env.SCHOOLOGY_USERNAME?.trim(),
    password: process.env.SCHOOLOGY_PASSWORD,
  };
  if (validCredentials(fromEnvironment)) return fromEnvironment;

  try {
    const parsed = JSON.parse(await readFile(credentialsPath(), "utf8"));
    if (validCredentials(parsed)) {
      return { username: parsed.username.trim(), password: parsed.password };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Could not read ${credentialsPath()}: ${error.message}`);
    }
  }

  throw new Error(
    "FCPS credentials are not configured. Run the setup command from the README first.",
  );
}

export async function saveCredentials(username, password) {
  const credentials = { username: String(username).trim(), password: String(password) };
  if (!validCredentials(credentials)) throw new Error("Both username and password are required.");

  const target = credentialsPath();
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  if (process.platform !== "win32") await chmod(target, 0o600);
  return target;
}

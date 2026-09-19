import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function configRoot() {
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

async function readCredentialsFile() {
  try {
    return JSON.parse(await readFile(credentialsPath(), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read ${credentialsPath()}: ${error.message}`);
  }
}

export async function loadCredentials() {
  const fromEnvironment = {
    username: process.env.SCHOOLOGY_USERNAME?.trim(),
    password: process.env.SCHOOLOGY_PASSWORD,
  };
  if (validCredentials(fromEnvironment)) return fromEnvironment;

  const parsed = await readCredentialsFile();
  if (validCredentials(parsed)) {
    return { username: parsed.username.trim(), password: parsed.password };
  }

  throw new Error(
    "FCPS credentials are not configured. Run the setup command from the README first.",
  );
}

// TJHSST Ion (the TJ intranet) is optional: only students at TJ have an account.
export async function loadIonCredentials() {
  const fromEnvironment = {
    username: process.env.ION_USERNAME?.trim(),
    password: process.env.ION_PASSWORD,
  };
  if (validCredentials(fromEnvironment)) return fromEnvironment;

  const parsed = await readCredentialsFile();
  if (validCredentials(parsed?.ion)) {
    return { username: parsed.ion.username.trim(), password: parsed.ion.password };
  }

  throw new Error(
    "Ion credentials are not configured. Re-run the setup command and answer yes to the TJHSST question.",
  );
}

export async function hasIonCredentials() {
  try {
    await loadIonCredentials();
    return true;
  } catch {
    return false;
  }
}

export async function saveCredentials(username, password, ion = null) {
  const credentials = { username: String(username).trim(), password: String(password) };
  if (!validCredentials(credentials)) throw new Error("Both username and password are required.");
  if (ion) {
    const ionCredentials = { username: String(ion.username).trim(), password: String(ion.password) };
    if (!validCredentials(ionCredentials)) throw new Error("Both Ion username and password are required.");
    credentials.ion = ionCredentials;
  }

  const target = credentialsPath();
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  if (process.platform !== "win32") await chmod(target, 0o600);
  return target;
}

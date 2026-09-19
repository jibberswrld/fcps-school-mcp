import { cp, copyFile, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stdin, stdout } from "node:process";
import { askCredentials, configureLocal } from "./setup.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERCEL_PACKAGE = "vercel@59.16.0";

export function buildMcpUrl(deploymentUrl, secret) {
  const base = String(deploymentUrl).trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("Vercel did not return a deployment URL.");
  return `${base}/api/mcp/${encodeURIComponent(secret)}`;
}

function deploymentUrl(output) {
  try {
    const result = JSON.parse(output);
    const url = result?.url ?? result?.deployment?.url;
    if (typeof url === "string") return url;
  } catch {}
  throw new Error("Vercel did not return a valid deployment result.");
}

export function runVercel(args, { cwd, input, captureOutput = false } = {}) {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ["--yes", VERCEL_PACKAGE, ...args], {
      cwd,
      stdio: [input == null ? "inherit" : "pipe", captureOutput ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    if (captureOutput) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(output.trim());
      else reject(new Error(`Vercel CLI exited with code ${code}.`));
    });
    if (input != null) child.stdin.end(`${input}\n`);
  });
}

export async function deployProject({ directory, projectName, username, password, secret, ion = null, runner = runVercel }) {
  await runner(["link", "--yes", "--project", projectName], { cwd: directory });
  for (const [name, value] of [
    ["SCHOOLOGY_USERNAME", username],
    ["SCHOOLOGY_PASSWORD", password],
    ["MCP_SECRET", secret],
    ...(ion ? [["ION_USERNAME", ion.username], ["ION_PASSWORD", ion.password]] : []),
  ]) {
    await runner(["env", "add", name, "production", "--sensitive"], { cwd: directory, input: value });
  }
  const deploymentResult = await runner(["deploy", "--prod", "--yes", "--json"], {
    cwd: directory,
    captureOutput: true,
  });
  return buildMcpUrl(deploymentUrl(deploymentResult), secret);
}

async function copyDeploymentSource(target) {
  await Promise.all([
    cp(join(PACKAGE_ROOT, "api"), join(target, "api"), { recursive: true }),
    cp(join(PACKAGE_ROOT, "src"), join(target, "src"), { recursive: true }),
    copyFile(join(PACKAGE_ROOT, "package.json"), join(target, "package.json")),
    copyFile(join(PACKAGE_ROOT, "vercel.json"), join(target, "vercel.json")),
  ]);
}

export async function runDeploy() {
  if (!stdin.isTTY) throw new Error("Deployment needs an interactive terminal.");

  stdout.write("\nFCPS School MCP — local + remote setup\n\n");
  stdout.write("This configures supported apps on this computer, installs the Vercel CLI, and creates a private remote MCP in your account.\n");
  stdout.write("Your credentials will be saved locally and stored as Secret environment variables in that Vercel project.\n\n");
  await runVercel(["login"]);
  stdout.write("\n");

  const { username, password, ion } = await askCredentials();

  stdout.write("\nSetting up local MCP access...\n");
  await configureLocal(username, password, undefined, ion);

  const secret = randomBytes(24).toString("base64url");
  const projectName = `fcps-school-mcp-${randomBytes(4).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), "fcps-school-mcp-deploy-"));

  try {
    stdout.write("\nCreating your private Vercel deployment...\n");
    await copyDeploymentSource(directory);
    const mcpUrl = await deployProject({ directory, projectName, username, password, secret, ion });
    stdout.write("\nDeployment complete. Keep this URL private:\n\n");
    stdout.write(`${mcpUrl}\n\n`);
    stdout.write("Paste this URL into any AI app that supports a custom remote MCP URL. Choose Streamable HTTP and No authentication if prompted.\n");
    stdout.write("In ChatGPT: enable Developer mode in Settings → Security, create a new app, choose No authentication, and paste the URL.\n\n");
    return mcpUrl;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

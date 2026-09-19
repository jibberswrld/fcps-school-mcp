import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authState, fcpsStatus } from "../src/fcps.js";

// Simulates FCPS without touching the network: Schoology and StudentVUE report
// "not signed in", the SSO landing pages carry no SAML form, and ForgeRock
// answers whatever `forgerock` returns.
function stubFetch(forgerock) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    const { hostname, pathname } = new URL(url);
    if (hostname === "aic.fcps.edu") return forgerock(pathname, init);
    if (pathname.startsWith("/v1/")) return new Response("Log in to Schoology", { status: 403, headers: { "content-type": "text/html" } });
    return new Response("<html><body>Sign In</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  return calls;
}

test.before(async () => {
  process.env.FCPS_SCHOOL_MCP_CONFIG_DIR = await mkdtemp(join(tmpdir(), "fcps-auth-test-"));
  process.env.SCHOOLOGY_USERNAME = "1234567";
  process.env.SCHOOLOGY_PASSWORD = ["not", "a", "real", "password"].join("-");
});

test("a broken SSO service is retried once and never pauses logins", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  try {
    const status = await fcpsStatus();
    assert.equal(status.schoology.ok, false);
    assert.match(status.schoology.error, /Schoology login failed twice/);
    assert.match(status.schoology.error, /HTTP 502/);
    assert.equal(status.paused, false, "a transient failure must not trigger the lockout pause");
    assert.equal(calls.filter((call) => call.url.includes("aic.fcps.edu")).length, 4, "two attempts per service, each reaching ForgeRock once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a rejected password pauses logins with the reason FCPS gave", async () => {
  const originalFetch = globalThis.fetch;
  let stage = 0;
  const calls = stubFetch((_, init) => {
    stage++;
    if (init.body === "{}") {
      return Response.json({
        authId: "x",
        callbacks: [
          { type: "NameCallback", output: [{ name: "prompt", value: "User Name" }], input: [{ name: "IDToken1", value: "" }] },
          { type: "PasswordCallback", output: [{ name: "prompt", value: "Password" }], input: [{ name: "IDToken2", value: "" }] },
          { type: "TextOutputCallback", output: [{ name: "message", value: "function x() {}" }, { name: "messageType", value: "4" }] },
        ],
      });
    }
    const submitted = JSON.parse(init.body);
    assert.equal(submitted.callbacks[0].input[0].value, "1234567");
    assert.equal(submitted.callbacks[1].input[0].value, process.env.SCHOOLOGY_PASSWORD);
    return Response.json({ code: 401, reason: "Unauthorized", message: "Authentication Failed" }, { status: 401 });
  });
  try {
    const status = await fcpsStatus();
    assert.equal(status.schoology.ok, false);
    assert.match(status.schoology.error, /FCPS rejected the username\/password/);
    assert.match(status.schoology.error, /Authentication Failed/);
    assert.equal(status.paused, true);
    assert.equal(status.studentVue.ok, false);
    assert.match(status.studentVue.error, /paused until/);
    assert.equal(stage, 2, "exactly one credential submission, then stop");
    assert.equal(calls.filter((call) => call.url.includes("aic.fcps.edu")).length, 2);
    assert.match(authState().reason, /rejected/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

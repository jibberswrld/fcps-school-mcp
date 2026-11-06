import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authState, callTool, fcpsStatus } from "../src/fcps.js";

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

test("a hidden Grade Book fails fast without re-login and leaves Schoology sections working", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    const { hostname, pathname } = new URL(url);
    if (pathname === "/v1/users/me") return Response.json({ uid: 42, name_display: "Test Student" });
    if (pathname === "/v1/users/42/sections") return Response.json({ section: [{ id: 7, section_title: "Period 1", course_title: "Physics", course_id: 9 }] });
    if (hostname === "sisstudent.fcps.edu" && pathname.endsWith("/PXP2_Gradebook.aspx")) return new Response(null, { status: 302, headers: { location: "/svue/Home_PXP2.aspx" } });
    return new Response("unexpected", { status: 500 });
  };
  try {
    const status = await fcpsStatus();
    assert.equal(status.schoology.ok, true);
    assert.equal(status.studentVue.ok, false);
    assert.match(status.studentVue.error, /turned the Grade Book off/);
    assert.equal(calls.filter((call) => call.url.includes("aic.fcps.edu")).length, 0, "a hidden Grade Book must not trigger a ForgeRock login");

    const [content] = await callTool("schoology_list_sections");
    const sections = JSON.parse(content.text);
    assert.equal(sections[0].courseTitle, "Physics");
    assert.equal(sections[0].officialGrade, null);
    assert.match(sections[0].officialGradeError, /turned the Grade Book off/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Schoology materials include later pages and make nested PDFs readable", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === "/v1/users/me") return Response.json({ uid: 42 });
    if (url.pathname === "/course/7/materials") {
      const html = url.searchParams.has("f") ? "" : '<a href="/course/7/materials?f=8">Unit 3</a>';
      return new Response(html);
    }
    const key = { documents: "document", pages: "page", assignments: "assignment" }[url.pathname.split("/").at(-1)];
    assert.ok(key, `Unexpected request: ${url}`);
    if (key === "assignment") assert.equal(url.searchParams.get("with_attachments"), "1");
    if (!url.searchParams.has("start")) {
      url.searchParams.set("start", "20");
      url.searchParams.set("limit", "20");
      return Response.json({ [key]: [{ id: 1, title: "First item" }], links: { next: url.href } });
    }
    const item = { id: 2, title: key === "document" ? "Unit 3.3 Slides.pdf" : "Later item", course_fid: 8 };
    if (key === "document") item.attachments = { files: { file: [{ title: item.title, extension: "pdf" }] } };
    return Response.json({ [key]: [item], links: { self: url.href } });
  });

  const [content] = await callTool("schoology_get_materials", { sectionId: "7" });
  const { folders, items } = JSON.parse(content.text);
  assert.deepEqual(folders, [{ id: "8", title: "Unit 3", parentId: null }]);
  assert.deepEqual(items.map(({ type, id }) => [type, id]), [
    ["document", "1"], ["document", "2"], ["page", "1"], ["page", "2"], ["assignment", "1"], ["assignment", "2"],
  ]);
  const slides = items[1];
  assert.equal(slides.folderId, "8");
  assert.equal(slides.files[0].title, "Unit 3.3 Slides.pdf");
  assert.deepEqual(slides.readWith, { tool: "schoology_read_document", sectionId: "7", documentId: "2" });
});

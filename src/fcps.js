import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configRoot, loadCredentials } from "./config.js";
import { downloadAttachment, readAttachment, readAttachmentResponse } from "./documents.js";

// FCPS-only endpoints. The server intentionally has no configurable outbound
// host so MCP tool arguments cannot turn it into a general-purpose HTTP proxy.

const BASE = "https://lms.fcps.edu";
const STUDENTVUE_BASE = "https://sisstudent.fcps.edu/svue";
const STUDENTVUE_SSO = "https://sis.fcps.edu/SIS/samlssoportal.aspx?whr=edupoint-idp-prod";
const FR = "https://aic.fcps.edu";
const REALM_PATH = "/am/json/realms/root/realms/alpha/authenticate";
const API_VERSION = "resource=2.1, protocol=1.0";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// ForgeRock locks the account after repeated bad passwords, so a login is paused
// ONLY when FCPS explicitly rejects the credentials. Network blips, SSO redirect
// hiccups and expired sessions are retried immediately instead.
const REJECTED_PAUSE_MS = 15 * 60 * 1000;
const LOCKOUT_PAUSE_MS = 60 * 60 * 1000;
const ALLOWED_HOSTS = new Set(["aic.fcps.edu", "app.schoology.com", "lms.fcps.edu", "sis.fcps.edu", "sisstudent.fcps.edu"]);

// ---- session state, persisted across warm invocations ----
const S = { jar: [], uid: null, pausedUntil: 0, pauseReason: "", loaded: false };

class CredentialsRejectedError extends Error {
  constructor(message, lockout = false) { super(message); this.name = "CredentialsRejectedError"; this.lockout = lockout; }
}
// Signed in, but FCPS has hidden the Grade Book (it does this during
// end-of-quarter grading). Logging in again cannot fix it, so it is not retried.
class GradebookUnavailableError extends Error {
  constructor() { super("StudentVUE is signed in, but FCPS has turned the Grade Book off right now (it usually does this while grades are being finalized). Schoology data is unaffected; try StudentVUE grades again later."); this.name = "GradebookUnavailableError"; }
}

// The cookie jar is cached on disk (local installs only; the file is 0600) so a
// client restart reuses the session instead of logging into FCPS again. Fewer
// logins means fewer chances to trip ForgeRock's lockout counter.
function sessionPath() { return join(configRoot(), "session.json"); }
async function loadSession() {
  if (S.loaded) return;
  S.loaded = true;
  try {
    const parsed = JSON.parse(await readFile(sessionPath(), "utf8"));
    if (Array.isArray(parsed?.jar) && Date.now() - (parsed.savedAt || 0) < 12 * 60 * 60 * 1000) S.jar = parsed.jar;
  } catch {}
}
async function saveSession() {
  try {
    await mkdir(configRoot(), { recursive: true, mode: 0o700 });
    await writeFile(sessionPath(), JSON.stringify({ savedAt: Date.now(), jar: S.jar }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(sessionPath(), 0o600);
  } catch {}
}
function clearCookies(hosts = null) {
  S.jar = hosts ? S.jar.filter((c) => !hosts.some((h) => h === c.domain || h.endsWith("." + c.domain))) : [];
  S.uid = null;
}
function pauseLogins(error) {
  const ms = error.lockout ? LOCKOUT_PAUSE_MS : REJECTED_PAUSE_MS;
  S.pausedUntil = Date.now() + ms;
  S.pauseReason = error.message;
}
function assertNotPaused() {
  if (Date.now() < S.pausedUntil) {
    throw new Error(`FCPS login is paused until ${new Date(S.pausedUntil).toISOString()} because ${S.pauseReason} Fix the credentials (re-run the setup command) to avoid locking the account.`);
  }
}
export function authState() {
  return { paused: Date.now() < S.pausedUntil, pausedUntil: S.pausedUntil ? new Date(S.pausedUntil).toISOString() : null, reason: S.pauseReason || null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function cookieHeader(url) {
  const { hostname, pathname, protocol } = new URL(url);
  return S.jar
    .filter((c) => (hostname === c.domain || hostname.endsWith("." + c.domain)) && pathname.startsWith(c.path) && (!c.secure || protocol === "https:"))
    .map((c) => `${c.name}=${c.value}`).join("; ");
}
function storeCookies(res, url) {
  const source = new URL(url);
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const raw of set) {
    const parts = raw.split(";").map((part) => part.trim());
    const i = parts[0].indexOf("="); if (i <= 0) continue;
    const name = parts[0].slice(0, i).trim(), value = parts[0].slice(i + 1).trim();
    const domainPart = parts.find((part) => /^domain=/i.test(part));
    const pathPart = parts.find((part) => /^path=/i.test(part));
    const domain = (domainPart?.slice(7) || source.hostname).replace(/^\./, "").toLowerCase();
    if (source.hostname !== domain && !source.hostname.endsWith("." + domain)) continue;
    const path = pathPart?.slice(5) || "/";
    const secure = parts.some((part) => /^secure$/i.test(part));
    const maxAge = parts.find((part) => /^max-age=/i.test(part));
    const expires = parts.find((part) => /^expires=/i.test(part));
    // Schoology clears cookies by re-setting them with a past expiry (value "deleted").
    // Keeping those would send e.g. login_landing_dest=deleted, which makes /assignment/<id> redirect to /deleted.
    const expired = maxAge ? Number(maxAge.slice(8)) <= 0 : expires ? new Date(expires.slice(8)).getTime() <= Date.now() : false;
    const index = S.jar.findIndex((c) => c.domain === domain && c.path === path && c.name === name);
    if (expired) { if (index >= 0) S.jar.splice(index, 1); continue; }
    if (index >= 0) Object.assign(S.jar[index], { value, secure }); else S.jar.push({ domain, path, secure, name, value });
  }
}
async function raw(url, init = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Blocked request to unexpected host: ${parsed.hostname}`);
  }
  const headers = { "User-Agent": UA, ...(init.headers || {}) };
  const ck = cookieHeader(url); if (ck) headers.Cookie = ck;
  const res = await fetch(url, { ...init, headers, redirect: init.redirect ?? "manual" });
  storeCookies(res, url);
  return res;
}
function deviceProfile() {
  return JSON.stringify({ identifier: "sgy-cloud", metadata: {
    hardware: { deviceMemory: 8, hardwareConcurrency: 8, maxTouchPoints: 0, display: { width: 1440, height: 900, pixelDepth: 24, angle: 0 } },
    browser: { userAgent: UA, appName: "Netscape", appCodeName: "Mozilla", appVersion: "5.0", product: "Gecko", productSub: "20030107", vendor: "Google Inc." },
    platform: { language: "en-US", platform: "MacIntel", userLanguages: ["en-US"], timezone: 300 } } });
}

async function forgerockStep(body) {
  const res = await raw(FR + REALM_PATH, { method: "POST", headers: { "Content-Type": "application/json", "Accept-API-Version": API_VERSION }, body });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`FCPS sign-in (ForgeRock) answered HTTP ${res.status} with a non-JSON page; the SSO service may be down or changed.`); }
  if (res.status === 401 || (data.code && data.code >= 400)) {
    const message = String(data.message || data.reason || "Authentication Failed");
    throw new CredentialsRejectedError(`FCPS rejected the username/password (ForgeRock said: "${message}").`, /lock/i.test(message));
  }
  if (res.status >= 400) throw new Error(`FCPS sign-in (ForgeRock) answered HTTP ${res.status}: ${String(data.message || text).slice(0, 200)}`);
  return data;
}
function fillCallbacks(callbacks, username, password) {
  const notes = [];
  for (const cb of callbacks) {
    const input = cb.input?.[0];
    if (cb.type === "NameCallback" && input) input.value = username;
    else if (cb.type === "PasswordCallback" && input) input.value = password;
    else if (cb.type === "DeviceProfileCallback" && input) input.value = deviceProfile();
    else if ((cb.type === "ConfirmationCallback" || cb.type === "ChoiceCallback") && input) input.value = 0;
    else if (cb.type === "BooleanAttributeInputCallback" && input) input.value = true;
    else if (cb.type === "TextOutputCallback") {
      const message = String(cb.output?.find((o) => o.name === "message")?.value ?? "");
      if (message && message.length < 300 && !/function|=>|document\./.test(message)) notes.push(message.trim());
    }
  }
  return notes;
}
async function forgerockAuth() {
  const { username, password } = await loadCredentials();
  clearCookies(["aic.fcps.edu"]);
  let data = await forgerockStep("{}");
  let previousShape = "";
  for (let stage = 0; stage < 10; stage++) {
    if (data.tokenId) return;
    if (!data.callbacks) throw new Error(`FCPS sign-in ended without a session${data.message ? ` (${data.message})` : ""}.`);
    const shape = data.callbacks.map((cb) => cb.type).join(",");
    const notes = fillCallbacks(data.callbacks, username, password);
    if (notes.some((n) => /lock/i.test(n))) throw new CredentialsRejectedError(`FCPS rejected the username/password (ForgeRock said: "${notes.find((n) => /lock/i.test(n))}").`, true);
    if (shape === previousShape && stage > 0) {
      throw new Error(`FCPS sign-in is asking for something this connector cannot answer (${shape}${notes.length ? `: ${notes.join(" | ")}` : ""}). Sign in once in a browser to check whether FCPS added a new step.`);
    }
    previousShape = shape;
    data = await forgerockStep(JSON.stringify(data));
  }
  throw new Error("FCPS sign-in did not finish after 10 steps.");
}
async function completeSaml() {
  let url = BASE + "/home";
  for (let i = 0; i < 8; i++) {
    const res = await raw(url, { headers: { Accept: "text/html" } });
    const loc = res.headers.get("location");
    if (loc) { url = new URL(loc, url).href; continue; }
    const text = await res.text();
    const action = text.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
    const fields = {};
    for (const m of text.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
      const n = m[0].match(/name="([^"]+)"/i), v = m[0].match(/value="([^"]*)"/i);
      if (n) fields[decodeEntities(n[1])] = v ? decodeEntities(v[1]) : "";
    }
    if (action && fields.SAMLResponse) {
      await raw(decodeEntities(action[1]), { method: "POST", body: new URLSearchParams(fields).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" } });
      return;
    }
    throw new Error("SAML step reached a non-form page (IdP session not established).");
  }
  throw new Error("SAML redirect chain did not resolve.");
}
async function apiFetch(path) {
  const url = path.startsWith("http") ? path : BASE + path;
  for (let attempt = 0; ; attempt++) {
    const res = await raw(url, { redirect: "follow", headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } });
    const body = await res.text();
    if (res.status !== 429 || attempt >= 4) return { status: res.status, ct: res.headers.get("content-type") || "", body };
    const retry = Number(res.headers.get("retry-after") || 0);
    await sleep(retry > 0 ? retry * 1000 : Math.min(1000 * 2 ** attempt, 8000));
  }
}
async function isAuthed() {
  try { const r = await apiFetch("/v1/users/me"); if (r.status === 429) return true;
    return r.status >= 200 && r.status < 300 && r.ct.includes("json") && !/Log in to Schoology/i.test(r.body);
  } catch { return false; }
}
// Runs `attempt` (which should end with the service authenticated) with the
// lockout rules: credential rejections pause further logins; anything else is
// retried once from a clean cookie jar before giving up.
async function withLogin(service, attempt) {
  await loadSession();
  assertNotPaused();
  let lastError;
  for (let round = 0; round < 2; round++) {
    try {
      const result = await attempt(round > 0);
      await saveSession();
      return result;
    } catch (error) {
      if (error instanceof CredentialsRejectedError) { pauseLogins(error); throw error; }
      if (error instanceof GradebookUnavailableError) throw error;
      lastError = error;
      clearCookies();
    }
  }
  throw new Error(`${service} login failed twice: ${lastError?.message || lastError}`);
}
async function ensureAuthed() {
  await loadSession();
  if (await isAuthed()) return;
  await withLogin("Schoology", async (fresh) => {
    if (!fresh) { try { await completeSaml(); } catch {} }
    if (!(await isAuthed())) {
      await forgerockAuth();
      await completeSaml();
    }
    if (!(await isAuthed())) throw new Error("FCPS sign-in succeeded but Schoology did not open a session.");
  });
}

async function completeStudentVueSaml() {
  let url = STUDENTVUE_SSO;
  let init = { headers: { Accept: "text/html" } };
  for (let step = 0; step < 14; step++) {
    const res = await raw(url, init);
    const loc = res.headers.get("location");
    if (loc) {
      url = new URL(loc, url).href;
      init = { headers: { Accept: "text/html" } };
      continue;
    }
    const body = await res.text();
    const action = body.match(/<form[^>]*action=["']([^"']+)["'][^>]*>/i);
    const fields = {};
    for (const m of body.matchAll(/<input[^>]*type=["']hidden["'][^>]*>/gi)) {
      const name = m[0].match(/name=["']([^"']+)["']/i), value = m[0].match(/value=["']([^"']*)["']/i);
      if (name) fields[decodeEntities(name[1])] = value ? decodeEntities(value[1]) : "";
    }
    if (action && fields.SAMLResponse) {
      url = new URL(decodeEntities(action[1]), url).href;
      init = { method: "POST", body: new URLSearchParams(fields).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" } };
      continue;
    }
    return { status: res.status, url, body };
  }
  throw new Error("StudentVUE SAML redirect chain did not resolve.");
}

async function studentVueShell() {
  const res = await raw(`${STUDENTVUE_BASE}/PXP2_Gradebook.aspx?AGU=0`, { headers: { Accept: "text/html" } });
  // Signed-out sessions go to Login_PXP.aspx; signed-in ones bounce Home when the Grade Book is off.
  if (/Home_PXP2\.aspx/i.test(res.headers.get("location") || "")) throw new GradebookUnavailableError();
  if (res.status < 200 || res.status >= 300) return null;
  const body = await res.text();
  return /PXP\.GBCurrentFocus\s*=/.test(body) ? body : null;
}

// Signed-out StudentVUE pages redirect to Login_PXP.aspx, so any 2xx is the page itself.
async function studentVuePage(page) {
  const res = await raw(`${STUDENTVUE_BASE}/${page}`, { headers: { Accept: "text/html" } });
  return res.status >= 200 && res.status < 300 ? res.text() : null;
}

// Loads a StudentVUE page, signing in (with the lockout rules) when the session is gone.
async function ensureStudentVue(load, what) {
  await loadSession();
  const existing = await load();
  if (existing) return existing;
  return withLogin("StudentVUE", async (fresh) => {
    let result = null;
    if (!fresh) {
      try { await completeStudentVueSaml(); result = await load(); } catch (error) { if (error instanceof GradebookUnavailableError) throw error; }
    }
    if (!result) {
      await forgerockAuth();
      await completeStudentVueSaml();
      result = await load();
    }
    if (!result) throw new Error(`FCPS sign-in succeeded but StudentVUE did not open ${what}.`);
    return result;
  });
}

const ensureStudentVueAuthed = () => ensureStudentVue(studentVueShell, "the gradebook");

// Diagnostic: tries each service and reports exactly why a login fails.
export async function fcpsStatus() {
  const check = async (fn) => {
    try { await fn(); return { ok: true }; } catch (error) { return { ok: false, error: error.message }; }
  };
  const schoology = await check(ensureAuthed);
  const studentVue = await check(ensureStudentVueAuthed);
  return { schoology, studentVue, ...authState() };
}

async function json(path) {
  const r = await apiFetch(path);
  if (r.status < 200 || r.status >= 300) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return JSON.parse(r.body);
}
async function uid() {
  if (!S.uid) { const me = await json("/v1/users/me"); S.uid = String(me.uid ?? me.id); }
  return S.uid;
}
const isoDate = (d) => d.toISOString().slice(0, 10);

// ---- tool implementations (live) ----
async function getProfile() { const p = await json("/v1/users/me"); return { uid: String(p.uid), name: p.name_display, username: p.username, schoolId: p.school_id, email: p.primary_email, timezone: p.tz_name }; }
async function getSections() { const d = await json(`/v1/users/${await uid()}/sections`); return (d.section ?? []).map((s) => ({ id: String(s.id), title: s.section_title, courseTitle: s.course_title, courseId: String(s.course_id) })); }
async function getUpcoming(days = 30) {
  const start = isoDate(new Date()), end = isoDate(new Date(Date.now() + days * 86400000));
  const d = await json(`/v1/users/${await uid()}/events?start_date=${start}&end_date=${end}`);
  return (d.event ?? []).map((e) => ({ id: e.id, title: e.title, type: e.type, realm: e.realm, start: e.start, end: e.has_end ? e.end : null, allDay: !!e.all_day, description: (e.description ?? "").replace(/\s+/g, " ").trim() || undefined }));
}
async function getCalendar(startISO, endISO) {
  const s = Math.floor(new Date(startISO ?? isoDate(new Date())).getTime() / 1000);
  const e = Math.floor(new Date(endISO ?? isoDate(new Date(Date.now() + 30 * 86400000))).getTime() / 1000);
  const arr = await json(`/calendar/${await uid()}?ajax=1&start=${s}&end=${e}`);
  return (arr ?? []).map((x) => ({ id: x.content_id, title: x.title, type: x.e_type, realm: x.realm, start: x.start, end: x.has_end === "1" ? x.end : null, link: x.titleLink ?? null }));
}
const normUpdates = (raw) => (raw ?? []).map((u) => ({ id: u.id, realm: u.realm, authorUid: u.uid, created: new Date((u.created || 0) * 1000).toISOString(), likes: u.likes ?? 0, comments: u.num_comments ?? 0, body: (u.body ?? "").replace(/\s+/g, " ").trim() }));
async function getRecent() { return normUpdates((await json("/v1/recent")).update); }
async function getSectionUpdates(sectionId) { return normUpdates((await json(`/v1/sections/${sectionId}/updates`)).update); }
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index], index); }
  }));
  return results;
}

// Whether the student has turned in a native Schoology (dropbox) assignment.
async function getDropboxSubmission(sectionId, assignmentId) {
  const r = await apiFetch(`/v1/sections/${sectionId}/submissions/${assignmentId}/${await uid()}?with_attachments=1`);
  if (r.status < 200 || r.status >= 300) return { status: "unknown", note: `Schoology returned HTTP ${r.status} for the submission list.` };
  const revisions = (JSON.parse(r.body).revision ?? []).filter((rev) => !Number(rev.draft));
  if (!revisions.length) return { status: "not_submitted", revisions: 0 };
  const latest = revisions.reduce((a, b) => (Number(b.created) > Number(a.created) ? b : a));
  return {
    status: "submitted",
    submittedAt: new Date(Number(latest.created) * 1000).toISOString(),
    late: !!Number(latest.late),
    revisions: revisions.length,
    files: (latest?.attachments?.files?.file ?? []).map((f) => f.title),
  };
}

async function getAssignments(sectionId) {
  const targets = sectionId ? [{ id: sectionId }] : await getSections();
  const out = [];
  for (const t of targets) {
    const d = await json(`/v1/sections/${t.id}/assignments?with_attachments=1`);
    for (const a of (d.assignment ?? [])) {
      const files = (a?.attachments?.files?.file ?? []).map((f) => ({ title: f.title, ext: (f.extension ?? "").toLowerCase(), mime: f.filemime, size: f.filesize != null ? Number(f.filesize) : undefined }));
      const externalTools = (a?.attachments?.external_tools?.external_tool ?? []).map((tool) => ({ id: String(tool.id), title: tool.title }));
      const type = a.type ?? "assignment";
      const platform = externalTools.length ? "external_tool" : type === "assignment" && Number(a.allow_dropbox) ? "schoology" : type;
      out.push({
        id: String(a.id), sectionId: t.id, courseTitle: t.courseTitle, title: a.title,
        due: a.due && !/^0000-00-00/.test(a.due) ? a.due : null,
        type, maxPoints: a.max_points != null ? Number(a.max_points) : undefined,
        webUrl: a.web_url, files,
        ...(externalTools.length ? { externalTools } : {}),
        submission: { platform, status: "unknown" },
        ...(files.length ? { readWith: { tool: "schoology_read_document", sectionId: t.id, documentId: String(a.id) } } : {}),
      });
    }
  }
  await mapLimit(out, 4, async (assignment) => {
    const { platform } = assignment.submission;
    if (platform === "schoology") {
      assignment.submission = { platform, ...(await getDropboxSubmission(assignment.sectionId, assignment.id)) };
    } else if (platform === "external_tool") {
      assignment.submission.note = "Submitted inside an embedded external tool (for example Google Assignments). Schoology does not record the turn-in; the status is unknown until it is graded.";
    } else if (platform === "assessment_v2") {
      assignment.submission.note = "Schoology assessment; the API does not expose whether it was submitted.";
    } else {
      assignment.submission.note = "This item has no Schoology dropbox, so nothing is submitted through Schoology.";
    }
  });
  return out;
}
function parseFolderLinks(html) {
  const out = [], seen = new Set();
  const re = /href="[^"]*materials\?(?:[^"']*?&(?:amp;)?)?f=(\d+)"[^>]*>([\s\S]{0,160}?)<\/a>/g; let m;
  while ((m = re.exec(html))) { const id = m[1]; const title = decodeEntities(m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()); if (title && !seen.has(id)) { seen.add(id); out.push({ id, title }); } }
  return out;
}
async function getMaterials(sectionId) {
  const folders = new Map();
  const assignmentFolders = new Map();
  const root = (await apiFetch(`/course/${sectionId}/materials`)).body;
  const q = [];
  for (const f of parseFolderLinks(root)) { folders.set(f.id, { id: f.id, title: f.title, parentId: null }); q.push(f.id); }
  let guard = 0;
  while (q.length && guard++ < 60) {
    const fid = q.shift();
    const html = (await apiFetch(`/course/${sectionId}/materials?f=${fid}`)).body;
    for (const match of html.matchAll(/href=["'][^"']*\/assignment\/(\d+)[^"']*["']/gi)) {
      assignmentFolders.set(match[1], fid);
    }
    for (const sf of parseFolderLinks(html)) if (!folders.has(sf.id)) { folders.set(sf.id, { id: sf.id, title: sf.title, parentId: fid }); q.push(sf.id); }
  }
  const items = [];
  const fileOf = (r) => (r?.attachments?.files?.file ?? []).map((f) => ({ title: f.title, ext: (f.extension ?? "").toLowerCase(), mime: f.filemime, downloadPath: f.download_path, pdfPath: f.converted_download_path }));
  for (const d of ((await json(`/v1/sections/${sectionId}/documents`)).document ?? [])) items.push({ type: "document", id: String(d.id), title: d.title, folderId: d.course_fid != null ? String(d.course_fid) : null, files: fileOf(d) });
  for (const p of ((await json(`/v1/sections/${sectionId}/pages`)).page ?? [])) items.push({ type: "page", id: String(p.id), title: p.title, folderId: p.course_fid != null ? String(p.course_fid) : null, files: fileOf(p) });
  for (const a of ((await json(`/v1/sections/${sectionId}/assignments?with_attachments=1`)).assignment ?? [])) {
    const files = fileOf(a);
    items.push({
      type: "assignment", id: String(a.id), title: a.title,
      folderId: a.course_fid != null ? String(a.course_fid) : assignmentFolders.get(String(a.id)) ?? null, files,
      ...(files.length ? { readWith: { tool: "schoology_read_document", sectionId, documentId: String(a.id) } } : {}),
    });
  }
  return { sectionId, folders: [...folders.values()], items };
}

async function readDocument(sectionId, contentId, options) {
  const documentResponse = await apiFetch(`/v1/sections/${sectionId}/documents/${contentId}`);
  let contentType = "document";
  let content;
  if (documentResponse.status >= 200 && documentResponse.status < 300) {
    content = JSON.parse(documentResponse.body);
  } else {
    const assignmentResponse = await apiFetch(`/v1/sections/${sectionId}/assignments/${contentId}?with_attachments=1`);
    if (assignmentResponse.status < 200 || assignmentResponse.status >= 300) {
      throw new Error(`Could not find document or assignment ${contentId} in section ${sectionId}.`);
    }
    contentType = "assignment";
    content = JSON.parse(assignmentResponse.body);
  }

  const files = content?.attachments?.files?.file ?? [];
  if (!files.length) throw new Error(`This ${contentType} has no downloadable file attachment.`);

  if (options.fileIndex != null && options.fileIndex >= files.length) throw new Error(`fileIndex exceeds this item's ${files.length} attachments.`);
  const extracted = [];
  const visuals = [];
  let remainingImages = options.pageCount;
  for (const [fileIndex, file] of files.entries()) {
    if (options.fileIndex != null && options.fileIndex !== fileIndex) continue;
    try {
      const attachmentId = (String(file.download_path).match(/attachment\/(\d+)\//) || [])[1];
      if (!attachmentId) throw new Error("Could not identify the attachment.");
      // The API's download host has no public DNS. The authenticated viewer
      // exposes a signed Schoology CDN URL for PDFs and original image files.
      const viewerResponse = await raw(`${BASE}/attachment/${attachmentId}/docviewer`, { redirect: "follow", headers: { Accept: "text/html" } });
      if (!viewerResponse.ok) throw new Error(`Attachment viewer failed (HTTP ${viewerResponse.status}).`);
      const viewer = (await viewerResponse.text()).replace(/\\\//g, "/");
      const match = viewer.match(/https:\/\/files-cdn\.schoology\.com\/[^\s"'<>\\)]+/);
      const imagePath = viewer.match(/href=["']((?:https:\/\/lms\.fcps\.edu)?\/system\/files\/attachments\/[^"'<>]+)["']/);
      let buffer;
      if (match) buffer = await downloadAttachment(decodeEntities(match[0]));
      else if (imagePath) {
        const response = await raw(new URL(decodeEntities(imagePath[1]), BASE).href, { redirect: "manual", signal: AbortSignal.timeout(20000) });
        buffer = response.status >= 300 && response.status < 400
          ? await downloadAttachment(new URL(response.headers.get("location"), BASE).href)
          : await readAttachmentResponse(response);
      } else throw new Error("No PDF or image is available from Schoology's document viewer.");
      const includeImages = options.includeImages && remainingImages > 0;
      const result = await readAttachment(buffer, { ...options, includeImages, pageCount: Math.max(1, remainingImages) });
      const renderedPages = result.images.map((image) => image.page);
      remainingImages -= result.images.length;
      for (const image of result.images) {
        visuals.push({ type: "text", text: `Attachment ${fileIndex}: ${file.title} — page ${image.page} of ${result.totalPages}` });
        visuals.push({ type: "image", data: image.data, mimeType: image.mimeType });
      }
      const nextPage = includeImages ? result.nextPage : options.includeImages ? options.startPage : result.textTruncated ? options.startPage + options.pageCount : null;
      extracted.push({
        fileIndex, title: file.title, chars: result.text.length, text: result.text,
        totalPages: result.totalPages, renderedPages, textTruncated: result.textTruncated,
        readWith: { tool: "schoology_read_document", sectionId, documentId: String(contentId), fileIndex },
        ...(result.warnings ? { warnings: result.warnings } : {}),
        ...(!result.text ? { note: "No text layer. Inspect the returned image content to read the scan, picture, or diagram." } : {}),
        ...(nextPage ? { nextReadWith: { tool: "schoology_read_document", sectionId, documentId: String(contentId), fileIndex, startPage: nextPage, pageCount: options.pageCount, includeImages: options.includeImages } } : {}),
      });
    } catch (error) {
      extracted.push({ fileIndex, title: file.title, chars: 0, text: "", error: String(error.message).replace(/https?:\/\/\S+/g, "[URL]") });
    }
  }
  if (extracted.every((file) => file.error)) throw new Error(extracted.map((file) => `${file.title}: ${file.error}`).join("; "));
  const combinedText = extracted.map((file) => `# ${file.title}\n\n${file.error ? `Error: ${file.error}` : file.text}`).join("\n\n");
  const text = combinedText.slice(0, 45000);
  return [{ type: "text", text: JSON.stringify({
    documentId: String(contentId), type: contentType, title: content.title,
    files: extracted.map(({ text, ...metadata }) => metadata), chars: text.length, text,
    textTruncated: combinedText.length > text.length || extracted.some((file) => file.textTruncated),
    visualNote: options.includeImages ? "Images follow this metadata in attachment/page order. Read diagrams, charts, equations, tables, and scans visually. Follow each file's nextReadWith for remaining pages or attachments." : "Images disabled. Text extraction cannot describe diagrams or scans; use includeImages=true to inspect them.",
  }, null, 2) }, ...visuals];
}

function jsonVariable(html, name) {
  const match = html.match(new RegExp(`${name.replaceAll(".", "\\.")}\\s*=\\s*([^;]+);`));
  if (!match) throw new Error(`StudentVUE response is missing ${name}.`);
  return JSON.parse(match[1]);
}

function jsonArrayAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  const start = markerIndex < 0 ? -1 : text.indexOf("[", markerIndex + marker.length);
  if (start < 0) return [];
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth++;
    else if (character === "]" && --depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  throw new Error("StudentVUE returned an incomplete assignment list.");
}

function textValue(value) {
  if (typeof value !== "string") return value == null ? "" : String(value);
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && "value" in parsed) return textValue(parsed.value);
  } catch {}
  return decodeEntities(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function studentVueMethod(agu, method, data) {
  const res = await raw(`${STUDENTVUE_BASE}/service/PXP2Communication.asmx/${method}`, {
    method: "POST", body: JSON.stringify(data),
    headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json", AGU: String(agu) },
  });
  const body = await res.text();
  if (res.status < 200 || res.status >= 300) throw new Error(`StudentVUE ${method} -> HTTP ${res.status}`);
  const envelope = JSON.parse(body);
  if (envelope?.d?.Error) throw new Error(`StudentVUE ${method}: ${envelope.d.Error.Message || "request failed"}`);
  return envelope?.d?.Data;
}

async function studentVueContext() {
  const shell = await ensureStudentVueAuthed();
  const current = jsonVariable(shell, "PXP.GBCurrentFocus");
  const gradebook = jsonVariable(shell, "PXP.GBFocusData");
  const focus = current.FocusArgs;
  const info = await studentVueMethod(focus.AGU, "GradebookFocusClassInfo", { request: {
    gradingPeriodGU: focus.gradePeriodGU, AGU: focus.AGU, orgYearGU: focus.OrgYearGU,
    schoolID: focus.schoolID, markPeriodGU: focus.markPeriodGU,
  } });
  const period = (gradebook.GradingPeriods || []).find((item) => item.GU === focus.gradePeriodGU);
  const school = (gradebook.Schools || []).find((item) => item.SchoolID === focus.schoolID);
  return { focus, info, gradingPeriod: period?.Name || null, school: school?.SchoolName || null };
}

async function studentVueClassSummaries(context) {
  const data = await studentVueMethod(context.focus.AGU, "LoadControl", {
    request: { control: "Gradebook_SchoolClasses", parameters: { ...context.focus, viewName: "subject" } },
  });
  const html = data?.html || "";
  const starts = [...html.matchAll(/<button\b[^>]*class=["'][^"']*\bcourse-title\b[^"']*["'][^>]*>/gi)];
  const byId = new Map((context.info.Classes || []).map((item) => [String(item.ID), item]));
  const classes = [];
  for (let index = 0; index < starts.length; index++) {
    const opening = starts[index][0];
    const blockStart = starts[index].index;
    const blockEnd = starts[index + 1]?.index ?? html.length;
    const block = html.slice(blockStart, blockEnd);
    const close = block.indexOf("</button>");
    const focusAttribute = opening.match(/data-focus=(["'])([\s\S]*?)\1/i);
    if (!focusAttribute || close < 0) continue;
    const itemFocus = JSON.parse(decodeEntities(focusAttribute[2])).FocusArgs;
    const classId = String(itemFocus.classID);
    const info = byId.get(classId);
    classes.push({
      classId,
      name: textValue(block.slice(opening.length, close)),
      teacher: info?.TeacherName || null,
      mark: textValue(block.match(/class=["']mark["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]),
      score: textValue(block.match(/class=["']score["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]) || null,
    });
  }
  return classes;
}

async function getStudentVueGrades() {
  const context = await studentVueContext();
  const classes = await studentVueClassSummaries(context);
  return { system: "FCPS SIS StudentVUE", school: context.school, gradingPeriod: context.gradingPeriod, classes };
}

async function studentVueClassDetails(context, course) {
  const data = await studentVueMethod(context.focus.AGU, "LoadControl", {
    request: { control: "Gradebook_ClassDetails", parameters: { ...context.focus, classID: Number(course.classId), viewName: "assignment" } },
  });
  const html = data?.html || "";
  const gridIndex = html.indexOf('id="AssignmentsGrid"');
  const rows = gridIndex >= 0 ? jsonArrayAfter(html.slice(gridIndex), '"dataSource":') : [];
  const categoryAttribute = html.match(/class=["'][^"']*\bCategoryWeights\b[^"']*["'][^>]*data-data-source=["']([^"']*)["']/i);
  const categories = categoryAttribute ? JSON.parse(decodeEntities(categoryAttribute[1])).map((category) => ({
    name: category.Category,
    weightPercent: category.PctOfGrade,
    currentGrade: category.CurrentGrade,
    totalPoints: category.TotalPoints,
    totalPossible: category.TotalPossible,
    mark: category.CalculatedMark,
  })) : [];
  return {
    ...course,
    categories,
    assignments: rows.map((row) => ({
      assignmentId: String(row.gradeBookId),
      title: textValue(row.GBAssignment),
      date: row.Date || null,
      category: row.GBAssignmentType || null,
      score: textValue(row.GBScore) || null,
      points: row.GBPoints || null,
      scoreType: row.GBScoreType || null,
      notes: textValue(row.GBNotes) || null,
      teacher: row.Teacher || course.teacher,
    })),
  };
}

async function getStudentVueAssignments(classId, query) {
  const context = await studentVueContext();
  const classes = await studentVueClassSummaries(context);
  const selected = classId ? classes.filter((course) => course.classId === String(classId)) : classes;
  if (classId && selected.length === 0) throw new Error(`No StudentVUE class found with classId ${classId}.`);
  const courses = [];
  for (const course of selected) courses.push(await studentVueClassDetails(context, course));
  const needle = String(query || "").trim().toLowerCase();
  if (needle) {
    for (const course of courses) course.assignments = course.assignments.filter((assignment) => assignment.title.toLowerCase().includes(needle));
  }
  return {
    system: "FCPS SIS StudentVUE", school: context.school, gradingPeriod: context.gradingPeriod,
    count: courses.reduce((sum, course) => sum + course.assignments.length, 0), courses,
  };
}

function normalizedCourseName(value) {
  return String(value || "").toLowerCase()
    .replace(/\b(honors?|ap|adv(?:anced)?|period|semester|year|[0-9]+[a-z]?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedAssignmentTitle(value) {
  return String(value || "").toLowerCase().replace(/&amp;/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function matchingCourse(courses, title) {
  const normalizedTitle = normalizedCourseName(title);
  return courses.find((course) => {
    const normalizedName = normalizedCourseName(course.name);
    return normalizedTitle && normalizedName && (normalizedTitle.includes(normalizedName) || normalizedName.includes(normalizedTitle));
  });
}

async function getSectionsWithGrades() {
  const [sections, grades] = await Promise.all([getSections(), getStudentVueGrades().catch((error) => ({ error }))]);
  if (grades.error) return sections.map((section) => ({ ...section, officialGrade: null, officialGradeError: grades.error.message }));
  return sections.map((section) => {
    const grade = matchingCourse(grades.classes, section.courseTitle || section.title);
    return {
      ...section,
      officialGrade: grade ? {
        source: grades.system,
        gradingPeriod: grades.gradingPeriod,
        classId: grade.classId,
        mark: grade.mark,
        score: grade.score,
        teacher: grade.teacher,
      } : null,
    };
  });
}

const htmlText = (html) => decodeEntities(String(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const htmlCells = (row, tag) => [...row.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => htmlText(m[1]));

async function getCourseHistory() {
  const html = await ensureStudentVue(() => studentVuePage("PXP2_CourseHistory.aspx?AGU=0"), "Course History");
  const history = jsonArrayAfter(html, "PXP.CourseHistory").map((year) => ({
    gradeLevel: year.Grade,
    terms: (year.Terms ?? []).map((term) => ({
      year: term.Year, term: term.TermName, school: term.SchoolName,
      courses: (term.Courses ?? []).map((course) => ({
        courseId: course.CourseID, title: course.CourseTitle, mark: course.Mark,
        creditsAttempted: Number(course.CreditsAttempted) || 0, creditsCompleted: Number(course.CreditsCompleted) || 0,
      })),
    })),
  }));
  // The plain credits table is the one whose header reads Subject Area / Required / Completed / In Progress / Remaining.
  const table = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1]).find((t) => /Required<\/th>/i.test(t)) || "";
  const credits = [...(table.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => {
    const [required, completed, inProgress, remaining] = htmlCells(m[1], "td").map(Number);
    return { subjectArea: htmlCells(m[1], "th")[0], required, completed, inProgress, remaining };
  });
  const [, required, completed, inProgress, remaining] = htmlCells(table.match(/<tfoot>([\s\S]*?)<\/tfoot>/i)?.[1] ?? "", "td").map(Number);
  const gpa = [...html.matchAll(/<div class="gpa">\s*<h2>([\s\S]*?)<\/h2>\s*<span class="gpa-score">([\s\S]*?)<\/span>/gi)]
    .map((m) => ({ type: htmlText(m[1]), value: Number(htmlText(m[2])) }));
  const testRequirements = [...html.matchAll(/<li data-status="([^"]*)"[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => ({
    test: htmlText(m[2].match(/<span class="title">([\s\S]*?)<\/span>/i)?.[1] ?? ""),
    status: m[1],
    result: htmlText(m[2].match(/<span class="performance-level">([\s\S]*?)<\/span>/i)?.[1] ?? ""),
    date: htmlText(m[2].match(/<span class="date">([\s\S]*?)<\/span>\s*<\/div>/i)?.[1] ?? "").replace(/^taken on\s*/i, ""),
  }));
  return {
    system: "FCPS SIS StudentVUE",
    classOf: htmlText(html.match(/<span class="class-of">([\s\S]*?)<\/span>/i)?.[1] ?? "").replace(/^Class of\s*/i, ""),
    diplomaType: htmlText(html.match(/Diploma Type<\/h4>\s*<h6[^>]*>([\s\S]*?)<\/h6>/i)?.[1] ?? ""),
    gpa, credits, creditTotals: { required, completed, inProgress, remaining }, testRequirements, history,
  };
}

// FCPS posts report cards and score reports after the year they cover, by late summer at the latest.
function schoolYearOf(date) {
  const [month, , year] = String(date).split("/").map(Number);
  if (!month || !year) return null;
  const start = month >= 8 ? year : year - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

// Document links carry a per-login token, so tools address documents by a hash of their stable fields.
async function getStudentVueDocuments() {
  const html = await ensureStudentVue(() => studentVuePage("PXP2_Documents.aspx?AGU=0"), "Documents");
  let rows = [];
  for (let at = html.indexOf('"dataSource":'); at >= 0 && !rows.length; at = html.indexOf('"dataSource":', at + 1)) {
    const list = jsonArrayAfter(html.slice(at), '"dataSource":');
    if (list.some((row) => "DocumentTitle" in row)) rows = list;
  }
  return rows.map((row) => {
    const title = htmlText(row.DocumentTitle), href = row.DocumentTitle.match(/href="([^"]+)"/i)?.[1];
    return {
      documentId: createHash("sha256").update(`${row.DocumentUploadDate}|${row.DocumentCategory}|${title}`).digest("hex").slice(0, 16),
      title, category: row.DocumentCategory, uploaded: row.DocumentUploadDate, schoolYear: schoolYearOf(row.DocumentUploadDate),
      url: href ? new URL(decodeEntities(href), `${STUDENTVUE_BASE}/`).href : null,
    };
  });
}

async function readStudentVueDocument(documentId, options) {
  const doc = (await getStudentVueDocuments()).find((item) => item.documentId === documentId);
  if (!doc) throw new Error(`No StudentVUE document ${documentId}. Call studentvue_list_documents for current IDs.`);
  if (!doc.url) throw new Error(`StudentVUE lists "${doc.title}" without a download link.`);
  const result = await readAttachment(await readAttachmentResponse(await raw(doc.url, { signal: AbortSignal.timeout(20000) })), options);
  const nextPage = options.includeImages ? result.nextPage : result.textTruncated ? options.startPage + options.pageCount : null;
  const text = result.text.slice(0, 45000);
  return [{ type: "text", text: JSON.stringify({
    documentId, title: doc.title, category: doc.category, uploaded: doc.uploaded,
    totalPages: result.totalPages, renderedPages: result.images.map((image) => image.page),
    chars: text.length, text, textTruncated: result.textTruncated || result.text.length > text.length,
    ...(!result.text ? { note: "No text layer. Inspect the returned page images to read it." } : {}),
    ...(nextPage ? { nextReadWith: { tool: "studentvue_read_document", documentId, startPage: nextPage, pageCount: options.pageCount, includeImages: options.includeImages } } : {}),
  }, null, 2) }, ...result.images.flatMap((image) => [
    { type: "text", text: `${doc.title} — page ${image.page} of ${result.totalPages}` },
    { type: "image", data: image.data, mimeType: image.mimeType },
  ])];
}

async function getAssignmentsWithGrades(sectionId) {
  const sections = await getSections();
  const selectedSections = sectionId ? sections.filter((section) => section.id === String(sectionId)) : sections;
  const [schoologyAssignments, studentVue] = await Promise.all([
    getAssignments(sectionId),
    getStudentVueAssignments().catch((error) => ({ error })),
  ]);
  if (studentVue.error) return schoologyAssignments.map((assignment) => ({ ...assignment, source: "Schoology", officialGradeError: studentVue.error.message }));
  const matchedStudentVueIds = new Set();
  const assignments = schoologyAssignments.map((assignment) => {
    const section = selectedSections.find((item) => item.id === assignment.sectionId);
    const course = matchingCourse(studentVue.courses, section?.courseTitle || section?.title || assignment.courseTitle);
    if (!course) return { ...assignment, source: "Schoology" };
    const title = normalizedAssignmentTitle(assignment.title);
    const grade = course.assignments.find((item) => {
      const candidate = normalizedAssignmentTitle(item.title);
      return title && candidate && (title === candidate || title.includes(candidate) || candidate.includes(title));
    });
    if (!grade) return { ...assignment, source: "Schoology", studentVueClassId: course.classId, courseMark: course.mark, courseScore: course.score };
    matchedStudentVueIds.add(`${course.classId}:${grade.assignmentId}`);
    return {
      ...assignment,
      source: "Schoology + FCPS SIS StudentVUE",
      studentVueClassId: course.classId,
      courseMark: course.mark,
      courseScore: course.score,
      category: grade.category,
      score: grade.score,
      points: grade.points,
      notes: grade.notes,
      teacher: grade.teacher,
    };
  });
  for (const course of studentVue.courses) {
    const section = selectedSections.find((item) => matchingCourse([course], item.courseTitle || item.title));
    if (!section) continue;
    for (const grade of course.assignments) {
      if (matchedStudentVueIds.has(`${course.classId}:${grade.assignmentId}`)) continue;
      assignments.push({
        id: grade.assignmentId,
        sectionId: section.id,
        courseTitle: section.courseTitle || section.title,
        title: grade.title,
        due: grade.date,
        type: "assignment",
        source: "FCPS SIS StudentVUE",
        studentVueClassId: course.classId,
        courseMark: course.mark,
        courseScore: course.score,
        category: grade.category,
        score: grade.score,
        points: grade.points,
        notes: grade.notes,
        teacher: grade.teacher,
      });
    }
  }
  return assignments;
}

const emptySchema = { type: "object", additionalProperties: false, properties: {} };
const idProperty = { type: "string", pattern: "^[0-9]{1,32}$" };

export const TOOLS = [
  { name: "schoology_get_profile", description: "Get the signed-in student's Schoology profile.", inputSchema: emptySchema },
  { name: "schoology_list_sections", description: "List enrolled Schoology sections with official StudentVUE course grades.", inputSchema: emptySchema },
  { name: "schoology_get_assignments", description: "List Schoology assignments with submission status (submitted, not submitted, or unknown), attachments, and matched StudentVUE scores.", inputSchema: { type: "object", additionalProperties: false, properties: { sectionId: idProperty } } },
  { name: "schoology_get_materials", description: "List a course's nested folders, documents, pages, and assignments.", inputSchema: { type: "object", additionalProperties: false, properties: { sectionId: idProperty }, required: ["sectionId"] } },
  { name: "schoology_read_document", description: "Read Schoology documents and assignment attachments as text plus actual page images. Preserves diagrams, charts, equations, tables, photos, and scanned pages. Returns up to 3 images per call with nextReadWith for remaining pages/files. Supports PDFs, converted DOCX/PPTX, and image attachments.", inputSchema: { type: "object", additionalProperties: false, properties: {
    sectionId: idProperty, documentId: idProperty,
    fileIndex: { type: "integer", minimum: 0, maximum: 999, description: "Optional zero-based attachment index; omit to read all attachments." },
    startPage: { type: "integer", minimum: 1, maximum: 10000, default: 1, description: "First page to show. Later pages also focus the text on the requested range." },
    pageCount: { type: "integer", minimum: 1, maximum: 3, default: 3, description: "Maximum page images across all attachments in this response." },
    includeImages: { type: "boolean", default: true, description: "Return actual image content for visual understanding. Set false for text-only clients." },
  }, required: ["sectionId", "documentId"] } },
  { name: "schoology_get_upcoming_events", description: "Get upcoming Schoology events within 1 to 180 days.", inputSchema: { type: "object", additionalProperties: false, properties: { days: { type: "integer", minimum: 1, maximum: 180 } } } },
  { name: "schoology_get_calendar", description: "Get Schoology calendar events between two ISO dates.", inputSchema: { type: "object", additionalProperties: false, properties: { start: { type: "string", format: "date" }, end: { type: "string", format: "date" } } } },
  { name: "schoology_get_recent_activity", description: "Get account-wide Schoology announcements and course updates.", inputSchema: emptySchema },
  { name: "schoology_get_section_updates", description: "Get recent posts for one Schoology section.", inputSchema: { type: "object", additionalProperties: false, properties: { sectionId: idProperty }, required: ["sectionId"] } },
  { name: "studentvue_get_grades", description: "Get official current course marks and percentages from FCPS StudentVUE.", inputSchema: emptySchema },
  { name: "studentvue_get_assignments", description: "Get official assignment grades from FCPS StudentVUE, optionally filtered by class or title.", inputSchema: { type: "object", additionalProperties: false, properties: { classId: idProperty, query: { type: "string", maxLength: 200 } } } },
  { name: "studentvue_get_course_history", description: "Get the student's high school transcript from FCPS StudentVUE: every course that earns high school credit, with final mark and credits by grade level, year, term, and school, plus cumulative GPA, credits earned versus diploma requirements by subject area, diploma type, and graduation test requirements. Only high-school-credit courses appear: entries under a middle school grade level are individual courses taken early (for example Algebra 1 in grade 8, sometimes transferred from another school), not that year's full record. Elementary and full middle school grades are only in report cards from studentvue_list_documents.", inputSchema: emptySchema },
  { name: "studentvue_list_documents", description: "List StudentVUE documents, including report cards from past years and test score reports (SOL, MAP). schoolYear is estimated from the upload date; titles do not reliably name the grade, so read the document for its grade level. Returns documentId values for studentvue_read_document.", inputSchema: emptySchema },
  { name: "studentvue_read_document", description: "Read a StudentVUE document such as a report card or test score report, as text plus actual page images. Returns up to 3 page images per call with nextReadWith for later pages.", inputSchema: { type: "object", additionalProperties: false, properties: {
    documentId: { type: "string", pattern: "^[0-9a-f]{16}$", description: "documentId from studentvue_list_documents." },
    startPage: { type: "integer", minimum: 1, maximum: 10000, default: 1 },
    pageCount: { type: "integer", minimum: 1, maximum: 3, default: 3 },
    includeImages: { type: "boolean", default: true, description: "Return actual page images. Set false for text-only clients." },
  }, required: ["documentId"] } },
];

function requireId(value, name) {
  if (!/^[0-9]{1,32}$/.test(String(value ?? ""))) throw new Error(`${name} must contain only digits.`);
  return String(value);
}

function optionalId(value, name) {
  return value == null ? undefined : requireId(value, name);
}

function optionalDate(value, name) {
  if (value == null) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a valid date in YYYY-MM-DD format.`);
  }
  return value;
}

function pagingOptions({ startPage = 1, pageCount = 3, includeImages = true }) {
  if (!Number.isInteger(startPage) || startPage < 1 || startPage > 10000) throw new Error("startPage must be an integer from 1 to 10000.");
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 3) throw new Error("pageCount must be an integer from 1 to 3.");
  if (typeof includeImages !== "boolean") throw new Error("includeImages must be a boolean.");
  return { startPage, pageCount, includeImages };
}

function onlyKeys(value, allowed) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`Unexpected tool argument: ${unexpected[0]}.`);
}

export function validateToolCall(name, value = {}) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Tool arguments must be an object.");
  if (name === "schoology_get_assignments") {
    onlyKeys(value, ["sectionId"]);
    return { sectionId: optionalId(value.sectionId, "sectionId") };
  }
  if (name === "schoology_get_materials") {
    onlyKeys(value, ["sectionId"]);
    return { sectionId: requireId(value.sectionId, "sectionId") };
  }
  if (name === "schoology_read_document") {
    onlyKeys(value, ["sectionId", "documentId", "fileIndex", "startPage", "pageCount", "includeImages"]);
    const { fileIndex } = value;
    if (fileIndex != null && (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 999)) throw new Error("fileIndex must be an integer from 0 to 999.");
    return { sectionId: requireId(value.sectionId, "sectionId"), documentId: requireId(value.documentId, "documentId"), fileIndex, ...pagingOptions(value) };
  }
  if (name === "studentvue_read_document") {
    onlyKeys(value, ["documentId", "startPage", "pageCount", "includeImages"]);
    if (!/^[0-9a-f]{16}$/.test(String(value.documentId ?? ""))) throw new Error("documentId must be a 16-character id from studentvue_list_documents.");
    return { documentId: value.documentId, ...pagingOptions(value) };
  }
  if (name === "schoology_get_upcoming_events") {
    onlyKeys(value, ["days"]);
    const days = value.days == null ? 30 : value.days;
    if (!Number.isInteger(days) || days < 1 || days > 180) throw new Error("days must be an integer from 1 to 180.");
    return { days };
  }
  if (name === "schoology_get_calendar") {
    onlyKeys(value, ["start", "end"]);
    return { start: optionalDate(value.start, "start"), end: optionalDate(value.end, "end") };
  }
  if (name === "schoology_get_section_updates") {
    onlyKeys(value, ["sectionId"]);
    return { sectionId: requireId(value.sectionId, "sectionId") };
  }
  if (name === "studentvue_get_assignments") {
    onlyKeys(value, ["classId", "query"]);
    if (value.query != null && typeof value.query !== "string") throw new Error("query must be a string.");
    const query = value.query?.trim();
    if (query && query.length > 200) throw new Error("query must be at most 200 characters.");
    return { classId: optionalId(value.classId, "classId"), query };
  }
  if (["schoology_get_profile", "schoology_list_sections", "schoology_get_recent_activity", "studentvue_get_grades", "studentvue_get_course_history", "studentvue_list_documents"].includes(name)) {
    onlyKeys(value, []);
    return {};
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function callTool(name, value = {}) {
  const args = validateToolCall(name, value);
  if (!name.startsWith("studentvue_")) await ensureAuthed();
  let data;
  if (name === "schoology_get_profile") data = await getProfile();
  else if (name === "schoology_list_sections") data = await getSectionsWithGrades();
  else if (name === "schoology_get_assignments") data = await getAssignmentsWithGrades(args.sectionId);
  else if (name === "schoology_get_materials") data = await getMaterials(args.sectionId);
  else if (name === "schoology_read_document") return readDocument(args.sectionId, args.documentId, args);
  else if (name === "schoology_get_upcoming_events") data = await getUpcoming(args.days);
  else if (name === "schoology_get_calendar") data = await getCalendar(args.start, args.end);
  else if (name === "schoology_get_recent_activity") data = await getRecent();
  else if (name === "schoology_get_section_updates") data = await getSectionUpdates(args.sectionId);
  else if (name === "studentvue_get_grades") data = await getStudentVueGrades();
  else if (name === "studentvue_get_assignments") data = await getStudentVueAssignments(args.classId, args.query);
  else if (name === "studentvue_get_course_history") data = await getCourseHistory();
  else if (name === "studentvue_list_documents") data = (await getStudentVueDocuments()).map(({ url, ...doc }) => doc);
  else if (name === "studentvue_read_document") return readStudentVueDocument(args.documentId, args);
  return [{ type: "text", text: JSON.stringify(data, null, 2) }];
}

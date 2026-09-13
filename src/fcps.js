import { loadCredentials } from "./config.js";

// FCPS-only endpoints. The server intentionally has no configurable outbound
// host so MCP tool arguments cannot turn it into a general-purpose HTTP proxy.

const BASE = "https://lms.fcps.edu";
const STUDENTVUE_BASE = "https://sisstudent.fcps.edu/svue";
const STUDENTVUE_SSO = "https://sis.fcps.edu/SIS/samlssoportal.aspx?whr=edupoint-idp-prod";
const FR = "https://aic.fcps.edu";
const REALM_PATH = "/am/json/realms/root/realms/alpha/authenticate";
const API_VERSION = "resource=2.1, protocol=1.0";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const AUTH_COOLDOWN_MS = 15 * 60 * 1000; // after a login failure, wait before retrying (ForgeRock lockout guard)
const ALLOWED_HOSTS = new Set(["aic.fcps.edu", "app.schoology.com", "lms.fcps.edu", "sis.fcps.edu", "sisstudent.fcps.edu"]);

// ---- session state, persisted across warm invocations ----
const S = { jar: [], uid: null, failAt: 0, fails: 0 };

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

async function forgerockAuth() {
  const { username, password } = await loadCredentials();
  const H = { "Content-Type": "application/json", "Accept-API-Version": API_VERSION };
  let data = await (await raw(FR + REALM_PATH, { method: "POST", headers: H, body: "{}" })).json();
  for (let stage = 0; stage < 6; stage++) {
    if (data.tokenId) return;
    if (!data.callbacks) throw new Error(`ForgeRock auth failed${data.message ? ": " + data.message : ""}.`);
    for (const cb of data.callbacks) {
      if (cb.type === "NameCallback") cb.input[0].value = username;
      else if (cb.type === "PasswordCallback") cb.input[0].value = password;
      else if (cb.type === "DeviceProfileCallback") cb.input[0].value = deviceProfile();
    }
    data = await (await raw(FR + REALM_PATH, { method: "POST", headers: H, body: JSON.stringify(data) })).json();
  }
  if (!data.tokenId) throw new Error("ForgeRock auth exhausted stages without a token.");
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
async function ensureAuthed() {
  if (await isAuthed()) return;
  if (S.fails >= 1 && Date.now() - S.failAt < AUTH_COOLDOWN_MS)
    throw new Error("Login is cooling down after a recent failure (lockout guard). Try again later or check credentials.");
  try {
    try { await completeSaml(); } catch {}
    if (!(await isAuthed())) {
      await forgerockAuth();
      await completeSaml();
    }
    if (!(await isAuthed())) throw new Error("Login completed but session is not authenticated.");
    S.fails = 0;
  } catch (e) { S.fails++; S.failAt = Date.now(); throw e; }
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
  if (res.status < 200 || res.status >= 300) return null;
  const body = await res.text();
  return /PXP\.GBCurrentFocus\s*=/.test(body) ? body : null;
}

async function ensureStudentVueAuthed() {
  let shell = await studentVueShell();
  if (shell) return shell;
  if (S.fails >= 1 && Date.now() - S.failAt < AUTH_COOLDOWN_MS)
    throw new Error("Login is cooling down after a recent failure (lockout guard). Try again later or check credentials.");
  try {
    await completeStudentVueSaml();
    shell = await studentVueShell();
    if (!shell) {
      await forgerockAuth();
      await completeStudentVueSaml();
      shell = await studentVueShell();
    }
    if (!shell) throw new Error("FCPS SSO completed but StudentVUE did not open the gradebook.");
    S.fails = 0;
    return shell;
  } catch (e) { S.fails++; S.failAt = Date.now(); throw e; }
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

async function readDocument(sectionId, contentId) {
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

  const extracted = [];
  for (const file of files) {
    const attachmentId = (String(file.download_path).match(/attachment\/(\d+)\//) || [])[1];
    if (!attachmentId) throw new Error(`Could not identify the attachment for ${file.title}.`);
    // The docviewer page exposes a signed, public files-cdn URL (the internal
    // api.lms.fcps.edu download host has no public DNS, so we can't use it directly).
    const viewer = await (await raw(`${BASE}/attachment/${attachmentId}/docviewer`, { redirect: "follow", headers: { Accept: "text/html" } })).text();
    const match = viewer.replace(/\\\//g, "/").match(/https:\/\/files-cdn\.schoology\.com\/[^\s"'<>\\)]+/);
    if (!match) throw new Error(`Could not resolve a readable PDF for ${file.title} (it may be image-only or unconverted).`);
    const buffer = Buffer.from(await (await fetch(match[0].replace(/&amp;/g, "&"))).arrayBuffer());
    let text = "";
    try {
      const { extractText } = await import("unpdf");
      const result = await extractText(new Uint8Array(buffer), { mergePages: true });
      text = (typeof result.text === "string" ? result.text : (result.text || []).join("\n")).replace(/\s+\n/g, "\n").trim();
    } catch (e) {
      throw new Error(`PDF text extraction failed for ${file.title}: ${e?.message || e}`);
    }
    if (!text) text = "(No extractable text — this attachment is likely a scanned image; OCR is not available.)";
    extracted.push({ title: file.title, chars: text.length, text });
  }

  const text = extracted.map((file) => `# ${file.title}\n\n${file.text}`).join("\n\n").slice(0, 45000);
  return {
    documentId: String(contentId), type: contentType, title: content.title,
    files: extracted.map(({ title, chars }) => ({ title, chars })), chars: text.length, text,
  };
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
  const [sections, grades] = await Promise.all([getSections(), getStudentVueGrades()]);
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

async function getAssignmentsWithGrades(sectionId) {
  const sections = await getSections();
  const selectedSections = sectionId ? sections.filter((section) => section.id === String(sectionId)) : sections;
  const [schoologyAssignments, studentVue] = await Promise.all([
    getAssignments(sectionId),
    getStudentVueAssignments(),
  ]);
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
  { name: "schoology_read_document", description: "Read text from a Schoology document or assignment attachment.", inputSchema: { type: "object", additionalProperties: false, properties: { sectionId: idProperty, documentId: idProperty }, required: ["sectionId", "documentId"] } },
  { name: "schoology_get_upcoming_events", description: "Get upcoming Schoology events within 1 to 180 days.", inputSchema: { type: "object", additionalProperties: false, properties: { days: { type: "integer", minimum: 1, maximum: 180 } } } },
  { name: "schoology_get_calendar", description: "Get Schoology calendar events between two ISO dates.", inputSchema: { type: "object", additionalProperties: false, properties: { start: { type: "string", format: "date" }, end: { type: "string", format: "date" } } } },
  { name: "schoology_get_recent_activity", description: "Get account-wide Schoology announcements and course updates.", inputSchema: emptySchema },
  { name: "schoology_get_section_updates", description: "Get recent posts for one Schoology section.", inputSchema: { type: "object", additionalProperties: false, properties: { sectionId: idProperty }, required: ["sectionId"] } },
  { name: "studentvue_get_grades", description: "Get official current course marks and percentages from FCPS StudentVUE.", inputSchema: emptySchema },
  { name: "studentvue_get_assignments", description: "Get official assignment grades from FCPS StudentVUE, optionally filtered by class or title.", inputSchema: { type: "object", additionalProperties: false, properties: { classId: idProperty, query: { type: "string", maxLength: 200 } } } },
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
    onlyKeys(value, ["sectionId", "documentId"]);
    return { sectionId: requireId(value.sectionId, "sectionId"), documentId: requireId(value.documentId, "documentId") };
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
  if (["schoology_get_profile", "schoology_list_sections", "schoology_get_recent_activity", "studentvue_get_grades"].includes(name)) {
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
  else if (name === "schoology_read_document") data = await readDocument(args.sectionId, args.documentId);
  else if (name === "schoology_get_upcoming_events") data = await getUpcoming(args.days);
  else if (name === "schoology_get_calendar") data = await getCalendar(args.start, args.end);
  else if (name === "schoology_get_recent_activity") data = await getRecent();
  else if (name === "schoology_get_section_updates") data = await getSectionUpdates(args.sectionId);
  else if (name === "studentvue_get_grades") data = await getStudentVueGrades();
  else if (name === "studentvue_get_assignments") data = await getStudentVueAssignments(args.classId, args.query);
  return [{ type: "text", text: JSON.stringify(data, null, 2) }];
}

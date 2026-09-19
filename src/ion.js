import { loadIonCredentials } from "./config.js";

const BASE = "https://ion.tjhsst.edu";
const API = `${BASE}/api`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const COOLDOWN_MS = 10 * 60 * 1000;
const ALLOWED_HOSTS = new Set(["ion.tjhsst.edu"]);
const S = { jar: [], failAt: 0, fails: 0, lastError: "" };

class CredentialsRejectedError extends Error {}

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}
function plainText(value) {
  return decodeEntities(String(value ?? "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?\s*>|<\/p>|<\/div>|<\/li>/gi, " ")
    .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function cookieHeader(url) {
  const { hostname, pathname, protocol } = new URL(url);
  return S.jar.filter((c) => (hostname === c.domain || hostname.endsWith(`.${c.domain}`))
    && pathname.startsWith(c.path) && (!c.secure || protocol === "https:"))
    .map((c) => `${c.name}=${c.value}`).join("; ");
}
function storeCookies(res, url) {
  const source = new URL(url);
  for (const rawCookie of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const parts = rawCookie.split(";").map((part) => part.trim());
    const split = parts[0].indexOf("="); if (split <= 0) continue;
    const name = parts[0].slice(0, split), value = parts[0].slice(split + 1);
    const domainPart = parts.find((part) => /^domain=/i.test(part));
    const pathPart = parts.find((part) => /^path=/i.test(part));
    const domain = (domainPart?.slice(7) || source.hostname).replace(/^\./, "").toLowerCase();
    if (source.hostname !== domain && !source.hostname.endsWith(`.${domain}`)) continue;
    const path = pathPart?.slice(5) || "/", secure = parts.some((part) => /^secure$/i.test(part));
    const old = S.jar.find((c) => c.name === name && c.domain === domain && c.path === path);
    if (old) Object.assign(old, { value, secure }); else S.jar.push({ name, value, domain, path, secure });
  }
}
async function raw(url, init = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) throw new Error(`Blocked request to unexpected host: ${parsed.hostname}`);
  const headers = { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) };
  const cookies = cookieHeader(url); if (cookies) headers.Cookie = cookies;
  const res = await fetch(url, { ...init, headers, redirect: init.redirect ?? "manual" });
  storeCookies(res, url);
  return res;
}
function pauseError() {
  const until = new Date(S.failAt + COOLDOWN_MS).toISOString();
  return new Error(`Ion login is paused until ${until} after Ion rejected the username/password (${S.lastError}). Fix the credentials and re-run setup.`);
}
function assertNotPaused() { if (S.fails && Date.now() - S.failAt < COOLDOWN_MS) throw pauseError(); }
function hiddenInput(html, name) {
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    const n = input[0].match(/\bname=["']([^"']+)["']/i), v = input[0].match(/\bvalue=["']([^"']*)["']/i);
    if (n?.[1] === name) return decodeEntities(v?.[1] || "");
  }
}
async function profileCheck() {
  try {
    const res = await raw(`${API}/profile`), text = await res.text();
    if (res.status !== 200 || !res.headers.get("content-type")?.includes("json")) return null;
    return JSON.parse(text);
  } catch { return null; }
}
async function login() {
  const { username, password } = await loadIonCredentials();
  for (let attempt = 0; attempt < 2; attempt++) {
    S.jar = [];
    try {
      const page = await raw(`${BASE}/login`, { headers: { Accept: "text/html" } });
      if (!page.ok) throw new Error(`Ion login page returned HTTP ${page.status}.`);
      const html = await page.text(), csrf = hiddenInput(html, "csrfmiddlewaretoken");
      if (!csrf) throw new Error("Ion login page did not contain a CSRF form token.");
      const body = new URLSearchParams({ csrfmiddlewaretoken: csrf, username, password, trust_device: "on", otp_token: "" });
      const res = await raw(`${BASE}/login`, { method: "POST", body: body.toString(), redirect: "manual", headers: {
        Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE}/login`, Origin: BASE,
      } });
      const responseText = await res.text(), decodedResponse = decodeEntities(responseText), message = plainText(responseText);
      const rejection = decodedResponse.match(/Invalid password[^.<"']*\.?|Intranet access restricted[^.<"']*\.?/i)?.[0];
      if (rejection) throw new CredentialsRejectedError(rejection.trim());
      if (/two[- ]factor|\b2fa\b|one[- ]time password|otp (?:is )?(?:required|enabled)|authentication code/i.test(message)) {
        const error = new Error("Ion 2FA is enabled and this connector cannot complete it."); error.noRetry = true; throw error;
      }
      if (res.status !== 302) throw new Error(`Ion login returned HTTP ${res.status} instead of a successful redirect.`);
      if (!S.jar.some((cookie) => cookie.name === "sessionid" && cookie.value)) throw new Error("Ion login redirected without setting a sessionid cookie.");
      const profile = await profileCheck();
      if (!profile) throw new Error("Ion login redirected, but the profile check was still unauthenticated.");
      S.failAt = 0; S.fails = 0; S.lastError = "";
      return profile;
    } catch (error) {
      S.jar = [];
      if (error instanceof CredentialsRejectedError) {
        S.failAt = Date.now(); S.fails++; S.lastError = error.message; throw pauseError();
      }
      if (attempt === 1) throw new Error(`Ion login failed after two attempts: ${error?.message || error}`);
    }
  }
}
async function ensureAuthed() {
  const profile = await profileCheck(); if (profile) return profile;
  assertNotPaused();
  return login();
}
function responseReason(data, text) {
  const reason = data?.detail ?? data?.error ?? data?.message;
  if (typeof reason === "string") return reason;
  if (reason != null) return JSON.stringify(reason);
  return text.trim() || "unknown error";
}
async function apiResponse(path, init = {}, authenticate = true) {
  if (authenticate) await ensureAuthed();
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await raw(url, init), text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch {}
  return { res, text, data };
}
async function getJson(path, authenticate = true) {
  const { res, text, data } = await apiResponse(path, {}, authenticate);
  if (!res.ok) throw new Error(`Ion API ${new URL(path, API).pathname} returned HTTP ${res.status}: ${responseReason(data, text)}`);
  if (data == null) throw new Error(`Ion API ${new URL(path, API).pathname} did not return JSON.`);
  return data;
}
function personName(value) {
  if (typeof value === "string") return value;
  return value?.full_name ?? value?.display_name ?? value?.name ?? value?.title ?? value?.room_number ?? value?.username ?? value?.ion_username ?? "";
}
function today() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function pageResults(data) { return Array.isArray(data) ? data : (data?.results ?? []); }

async function getProfile() {
  const p = await ensureAuthed();
  return { id: p.id, username: p.ion_username, fullName: p.full_name, displayName: p.display_name,
    grade: { number: p.grade?.number ?? null, name: p.grade?.name ?? null }, emails: p.emails ?? [], counselor: personName(p.counselor) || null };
}
function scheduleDay(day) {
  const type = day?.day_type ?? {};
  return { date: day?.date, dayType: type.name ?? "NO SCHOOL", special: !!type.special,
    blocks: (type.blocks ?? []).map((block) => ({ name: block.name, start: block.start, end: block.end })) };
}
async function getSchedule(date, days) {
  const data = await getJson(date ? `/schedule/${date}` : `/schedule?page_size=${days}`, false);
  const values = date ? (Array.isArray(data) ? data : data?.results ?? [data]) : pageResults(data);
  return values.filter(Boolean).slice(0, date ? 1 : days).map(scheduleDay);
}
function announcement(value, limit) {
  const content = plainText(value?.content), cut = content.length > limit;
  return { id: value?.id, title: value?.title, author: personName(value?.author) || personName(value?.user) || null,
    added: value?.added, updated: value?.updated, pinned: !!value?.pinned, content: cut ? content.slice(0, limit) : content, ...(cut ? { truncated: true } : {}) };
}
async function getAnnouncements(page, query) {
  const data = await getJson(`/announcements?page=${page}`), needle = query?.toLowerCase();
  let values = pageResults(data);
  if (needle) values = values.filter((item) => `${item?.title ?? ""} ${plainText(item?.content)}`.toLowerCase().includes(needle));
  return { page, total: data?.count ?? values.length, hasMore: !!data?.next, announcements: values.map((item) => announcement(item, 2000)) };
}
async function getAnnouncement(id) { return announcement(await getJson(`/announcements/${id}`), 20000); }
async function listBlocks(date, startDate) {
  const params = new URLSearchParams();
  if (date) params.set("date", date); if (startDate) params.set("start_date", startDate);
  let next = `/blocks?${params}`, pages = 0; const out = [];
  while (next && pages++ < 4) {
    const data = await getJson(next);
    for (const block of pageResults(data)) out.push({ blockId: String(block.id), date: block.date, letter: block.block_letter, locked: !!block.locked });
    next = data?.next || null;
  }
  return out;
}
function names(values) { return (values ?? []).map(personName).filter(Boolean); }
async function getBlockActivities(blockId, query) {
  const block = await getJson(`/blocks/${blockId}`), needle = query?.toLowerCase();
  let values = Object.values(block?.activities ?? {});
  if (needle) values = values.filter((item) => `${item?.name ?? ""} ${plainText(item?.description)}`.toLowerCase().includes(needle));
  const activities = values.map((item) => {
    const capacity = Number(item?.roster?.capacity ?? 0), signedUp = Number(item?.roster?.count ?? 0), full = capacity > 0 && signedUp >= capacity;
    return { scheduledActivityId: item?.scheduled_activity?.id == null ? null : String(item.scheduled_activity.id),
      activityId: item?.id == null ? null : String(item.id), name: item?.name ?? item?.title ?? "", description: plainText(item?.description).slice(0, 400),
      rooms: names(item?.rooms), sponsors: names(item?.sponsors), capacity, signedUp, full,
      open: !item?.cancelled && !item?.restricted_for_user && !full && !block?.locked, cancelled: !!item?.cancelled,
      restricted: !!item?.restricted, restrictedForUser: !!item?.restricted_for_user, sticky: !!item?.sticky,
      presign: !!item?.presign, bothBlocks: !!item?.both_blocks, waitlistCount: Number(item?.waitlist_count ?? 0), favorited: !!item?.favorited };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { blockId: String(block.id ?? blockId), date: block.date, letter: block.block_letter, locked: !!block.locked, activities };
}
async function getMySignups(date, startDate) {
  const params = new URLSearchParams(); if (date) params.set("date", date); if (startDate) params.set("start_date", startDate);
  return pageResults(await getJson(`/signups/user?${params}`)).map((item) => ({ signupId: item.id == null ? null : String(item.id),
    blockId: item.block?.id == null ? null : String(item.block.id), date: item.block?.date, letter: item.block?.block_letter,
    activityId: item.activity?.id == null ? null : String(item.activity.id), activityName: item.activity?.title ?? item.activity?.name,
    scheduledActivityId: item.scheduled_activity?.id == null ? null : String(item.scheduled_activity.id) }));
}
async function signup(args) {
  const payload = args.scheduledActivityId ? { scheduled_activity: args.scheduledActivityId, use_scheduled_activity: true }
    : { block: args.blockId, activity: args.activityId };
  const { res, text, data } = await apiResponse("/signups/user", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if ([400, 403].includes(res.status)) throw new Error(`Ion refused the signup: ${responseReason(data, text)}`);
  if (!res.ok) throw new Error(`Ion signup failed with HTTP ${res.status}: ${responseReason(data, text)}`);
  if (res.status !== 201) throw new Error(`Ion signup returned unexpected HTTP ${res.status}.`);
  const scheduled = data?.scheduled_activity ?? data, block = data?.block ?? scheduled?.block ?? {}, activity = data?.activity ?? scheduled?.activity ?? data ?? {};
  const suppliedMessage = data?.message ?? data?.detail, waitlisted = data?.waitlisted === true || /waitlist/i.test(String(suppliedMessage ?? ""));
  const message = typeof suppliedMessage === "string" ? suppliedMessage : (waitlisted ? "Added to the waitlist." : "Signed up successfully.");
  return { status: waitlisted ? "waitlisted" : "signed_up", block: { id: block.id == null ? null : String(block.id), date: block.date ?? null,
    letter: block.block_letter ?? null }, activity: { id: activity.id == null ? null : String(activity.id), name: activity.name ?? activity.title ?? null },
    message };
}

const emptySchema = { type: "object", additionalProperties: false, properties: {} };
const idProperty = { type: "string", pattern: "^[0-9]{1,32}$" };
const dateProperty = { type: "string", format: "date" };
export const ION_TOOLS = [
  { name: "ion_get_profile", description: "Get the signed-in student's Ion profile.", inputSchema: emptySchema },
  { name: "ion_get_schedule", description: "Get one Ion schedule day by date or the next 1 to 7 days.", inputSchema: { type: "object", additionalProperties: false, properties: { date: dateProperty, days: { type: "integer", minimum: 1, maximum: 7 } } } },
  { name: "ion_get_announcements", description: "List one page of Ion announcements, optionally filtered by title and content.", inputSchema: { type: "object", additionalProperties: false, properties: { page: { type: "integer", minimum: 1 }, query: { type: "string", maxLength: 200 } } } },
  { name: "ion_get_announcement", description: "Get one Ion announcement with its full plain-text content.", inputSchema: { type: "object", additionalProperties: false, properties: { id: idProperty }, required: ["id"] } },
  { name: "ion_list_blocks", description: "List upcoming Ion eighth-period blocks, following up to four result pages.", inputSchema: { type: "object", additionalProperties: false, properties: { date: dateProperty, startDate: dateProperty } } },
  { name: "ion_get_block_activities", description: "List and search the activities available in an Ion eighth-period block.", inputSchema: { type: "object", additionalProperties: false, properties: { blockId: idProperty, query: { type: "string" } }, required: ["blockId"] } },
  { name: "ion_get_my_signups", description: "List the signed-in student's Ion eighth-period signups.", inputSchema: { type: "object", additionalProperties: false, properties: { date: dateProperty, startDate: dateProperty } } },
  { name: "ion_signup_eighth_period", description: "Change real Ion state by signing up for an eighth-period activity. If you already have a signup for that block, Ion moves you to the new activity.", inputSchema: { type: "object", additionalProperties: false, properties: { scheduledActivityId: idProperty, blockId: idProperty, activityId: idProperty } } },
];

function requireId(value, name) {
  if (!/^[0-9]{1,32}$/.test(String(value ?? ""))) throw new Error(`${name} must contain only digits.`);
  return String(value);
}
function optionalId(value, name) { return value == null ? undefined : requireId(value, name); }
function optionalDate(value, name) {
  if (value == null) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${name} must be a valid date in YYYY-MM-DD format.`);
  return value;
}
function query(value, max = Infinity) {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error("query must be a string.");
  const normalized = value.trim(); if (normalized.length > max) throw new Error(`query must be at most ${max} characters.`);
  return normalized || undefined;
}
function onlyKeys(value, allowed) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Unexpected tool argument: ${unexpected}.`);
}
export function validateIonToolCall(name, value = {}) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Tool arguments must be an object.");
  if (name === "ion_get_profile") { onlyKeys(value, []); return {}; }
  if (name === "ion_get_schedule") { onlyKeys(value, ["date", "days"]); const date = optionalDate(value.date, "date"), days = value.days ?? 1;
    if (!Number.isInteger(days) || days < 1 || days > 7) throw new Error("days must be an integer from 1 to 7."); return { date, days }; }
  if (name === "ion_get_announcements") { onlyKeys(value, ["page", "query"]); const page = value.page ?? 1;
    if (!Number.isInteger(page) || page < 1) throw new Error("page must be an integer of at least 1."); return { page, query: query(value.query, 200) }; }
  if (name === "ion_get_announcement") { onlyKeys(value, ["id"]); return { id: requireId(value.id, "id") }; }
  if (["ion_list_blocks", "ion_get_my_signups"].includes(name)) { onlyKeys(value, ["date", "startDate"]); const date = optionalDate(value.date, "date");
    return { date, startDate: optionalDate(value.startDate, "startDate") ?? (date ? undefined : today()) }; }
  if (name === "ion_get_block_activities") { onlyKeys(value, ["blockId", "query"]); return { blockId: requireId(value.blockId, "blockId"), query: query(value.query) }; }
  if (name === "ion_signup_eighth_period") {
    onlyKeys(value, ["scheduledActivityId", "blockId", "activityId"]);
    const args = { scheduledActivityId: optionalId(value.scheduledActivityId, "scheduledActivityId"), blockId: optionalId(value.blockId, "blockId"), activityId: optionalId(value.activityId, "activityId") };
    if (!args.scheduledActivityId && !(args.blockId && args.activityId)) throw new Error("Provide scheduledActivityId, or both blockId and activityId.");
    return args;
  }
  throw new Error(`Unknown tool: ${name}`);
}
export async function callIonTool(name, value = {}) {
  const args = validateIonToolCall(name, value); let data;
  if (name === "ion_get_profile") data = await getProfile();
  else if (name === "ion_get_schedule") data = await getSchedule(args.date, args.days);
  else if (name === "ion_get_announcements") data = await getAnnouncements(args.page, args.query);
  else if (name === "ion_get_announcement") data = await getAnnouncement(args.id);
  else if (name === "ion_list_blocks") data = await listBlocks(args.date, args.startDate);
  else if (name === "ion_get_block_activities") data = await getBlockActivities(args.blockId, args.query);
  else if (name === "ion_get_my_signups") data = await getMySignups(args.date, args.startDate);
  else if (name === "ion_signup_eighth_period") data = await signup(args);
  return [{ type: "text", text: JSON.stringify(data, null, 2) }];
}
export async function ionStatus() {
  let credentials;
  try { credentials = await loadIonCredentials(); }
  catch (error) { return { configured: false, authenticated: false, error: error?.message || String(error) }; }
  const base = { configured: true, authenticated: false, username: credentials.username };
  try { const profile = await ensureAuthed(); return { ...base, authenticated: true, username: profile?.ion_username ?? credentials.username }; }
  catch (error) { return { ...base, error: error?.message || String(error) }; }
}

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { downloadAttachment, readAttachment } from "../src/documents.js";
import { validateToolCall } from "../src/fcps.js";
import { createServer } from "../src/server.js";

// A tiny, real PDF containing text, a vector diagram, and an optional scanned
// page. No student documents, signed URLs, or third-party fixture downloads.
function pdfFixture({ pages = 4, scan = false, label, fontSize = 14 } = {}) {
  const stream = (data, dictionary = "") => Buffer.concat([Buffer.from(`<< /Length ${data.length} ${dictionary} >>\nstream\n`), data, Buffer.from("\nendstream")]);
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (let page = 1; page <= pages; page++) {
    const id = objects.length + 1;
    kids.push(`${id} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> /XObject << /Scan ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const drawing = scan ? "q 160 0 0 160 20 20 cm /Scan Do Q" : `BT /F1 ${fontSize} Tf 20 170 Td (${label ?? `Diagram page ${page}`}) Tj ET 1 0 0 rg 40 40 100 100 re f`;
    objects.push(stream(Buffer.from(drawing)));
    objects.push(stream(Buffer.from([0, 160, 0]), "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8"));
  }
  objects[1] = `<< /Type /Pages /Count ${pages} /Kids [${kids.join(" ")}] >>`;
  let pdf = Buffer.from("%PDF-1.7\n");
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf = Buffer.concat([pdf, Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from("\nendobj\n")]);
  });
  const xref = pdf.length;
  return Buffer.concat([pdf, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)]);
}

async function centerPixel(image) {
  const decoded = await loadImage(Buffer.from(image.data, "base64"));
  const canvas = createCanvas(decoded.width, decoded.height);
  const context = canvas.getContext("2d");
  context.drawImage(decoded, 0, 0);
  return context.getImageData(Math.floor(decoded.width / 2), Math.floor(decoded.height / 2), 1, 1).data;
}

test("renders vector diagrams while retaining full document text and paging images", async () => {
  const buffer = pdfFixture();
  const first = await readAttachment(buffer);
  assert.equal(first.totalPages, 4);
  assert.match(first.text, /Diagram page 4/);
  assert.deepEqual(first.images.map((image) => image.page), [1, 2, 3]);
  assert.equal(first.nextPage, 4);
  const [red, green, blue] = await centerPixel(first.images[0]);
  assert.ok(red > 240 && green < 10 && blue < 10, "the vector rectangle must be visible in the returned image");
  const last = await readAttachment(buffer, { startPage: 4, pageCount: 2 });
  assert.equal(last.nextPage, null);
  assert.equal(last.images[0].page, 4);
  assert.match(last.text, /Diagram page 4/);
  assert.doesNotMatch(last.text, /Diagram page 1/);
  await assert.rejects(readAttachment(buffer, { startPage: 5 }), /exceeds/);
});

test("returns scanned page pixels even when the PDF has no text layer", async () => {
  const result = await readAttachment(pdfFixture({ pages: 1, scan: true }));
  assert.equal(result.text, "");
  assert.equal(result.images.length, 1);
  const [red, green, blue] = await centerPixel(result.images[0]);
  assert.ok(green > 150 && red < 10 && blue < 10);
});

test("reports truncated text and keeps later pages reachable", async () => {
  const buffer = pdfFixture({ label: "small ".repeat(3000), fontSize: 0.01 });
  const first = await readAttachment(buffer, { includeImages: false });
  assert.equal(first.textTruncated, true);
  assert.ok(first.text.length <= 45000);
  const last = await readAttachment(buffer, { includeImages: false, startPage: 4, pageCount: 1 });
  assert.equal(last.textTruncated, false);
  assert.match(last.text, /small/);
});

test("returns native image attachments and supports text-only mode", async () => {
  const canvas = createCanvas(2400, 600);
  const context = canvas.getContext("2d");
  context.fillStyle = "blue";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const buffer = canvas.toBuffer("image/png");
  const result = await readAttachment(buffer);
  assert.equal(result.images[0].width, 1800);
  assert.equal(result.images[0].height, 450);
  assert.ok((await centerPixel(result.images[0]))[2] > 240);
  assert.deepEqual((await readAttachment(buffer, { includeImages: false })).images, []);
  assert.deepEqual((await readAttachment(pdfFixture(), { includeImages: false })).images, []);
  await assert.rejects(readAttachment(buffer, { startPage: 2 }), /only one page/);
});

test("validates page, attachment, and image controls before making requests", () => {
  const args = { sectionId: "1", documentId: "2" };
  assert.equal(validateToolCall("schoology_read_document", args).includeImages, true);
  for (const invalid of [{ startPage: 0 }, { startPage: "1" }, { pageCount: 4 }, { pageCount: 1.5 }, { fileIndex: -1 }, { includeImages: "false" }, { url: "https://example.com" }]) {
    assert.throws(() => validateToolCall("schoology_read_document", { ...args, ...invalid }));
  }
});

test("downloads only bounded Schoology CDN files without cookies or redirects", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return new Response("file");
  });
  for (const url of ["http://files-cdn.schoology.com/file", "https://files-cdn.schoology.com.evil.test/file", "https://localhost/file", "https://user:password@files-cdn.schoology.com/file"]) {
    await assert.rejects(downloadAttachment(url), /Blocked/);
  }
  assert.equal(calls.length, 0);
  assert.equal((await downloadAttachment("https://files-cdn.schoology.com/file")).toString(), "file");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers, undefined);
  t.mock.method(globalThis, "fetch", async () => new Response("denied", { status: 403 }));
  await assert.rejects(downloadAttachment("https://files-cdn.schoology.com/file"), /HTTP 403/);
  t.mock.method(globalThis, "fetch", async () => new Response("large", { headers: { "content-length": String(26 * 1024 * 1024) } }));
  await assert.rejects(downloadAttachment("https://files-cdn.schoology.com/file"), /25 MB/);
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(26 * 1024 * 1024)));
  await assert.rejects(downloadAttachment("https://files-cdn.schoology.com/file"), /25 MB/);
});

test("MCP returns labeled images, exact continuations, and per-file errors for assignments", async (t) => {
  process.env.FCPS_SCHOOL_MCP_CONFIG_DIR = await mkdtemp(join(tmpdir(), "fcps-documents-test-"));
  const png = createCanvas(100, 100).toBuffer("image/png");
  const paths = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const { hostname, pathname } = new URL(url);
    paths.push(pathname);
    if (pathname === "/v1/users/me") return Response.json({ uid: "1" });
    if (pathname.includes("/documents/")) return new Response("missing", { status: 404 });
    if (pathname.includes("/assignments/")) return Response.json({ title: "Diagrams", attachments: { files: { file: [
      { title: "drawing.pdf", download_path: "/attachment/10/source/file.pdf" },
      { title: "picture.png", download_path: "/attachment/11/source/file.png" },
      { title: "unsupported.zip", download_path: "/attachment/12/source/file.zip" },
    ] } } });
    if (pathname === "/attachment/10/docviewer") return new Response('<a href="https://files-cdn.schoology.com/drawing.pdf?x=1&amp;y=2">PDF</a>');
    if (pathname === "/attachment/11/docviewer") return new Response('<a href="https://lms.fcps.edu/system/files/attachments/picture.png">Download File</a>');
    if (pathname === "/attachment/12/docviewer") return new Response("No preview available");
    if (pathname === "/system/files/attachments/picture.png") {
      assert.equal(init.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://files-cdn.schoology.com/picture.png" } });
    }
    if (hostname === "files-cdn.schoology.com") return new Response(pathname.endsWith(".png") ? png : pdfFixture());
    throw new Error(`Unexpected request: ${pathname}`);
  });
  const server = createServer();
  const client = new Client({ name: "visual-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "schoology_read_document", arguments: { sectionId: "1", documentId: "2" } });
  assert.ok(!result.isError);
  const metadata = JSON.parse(result.content[0].text);
  assert.equal(metadata.type, "assignment");
  assert.equal(result.content.filter((content) => content.type === "image").length, 3);
  assert.equal(metadata.files[0].nextReadWith.startPage, 4);
  assert.equal(metadata.files[1].nextReadWith.fileIndex, 1);
  assert.equal(metadata.files[1].nextReadWith.startPage, 1);
  assert.match(metadata.files[2].error, /No PDF or image/);
  assert.match(result.content[1].text, /drawing.pdf.*page 1 of 4/);
  const { tool, ...continuation } = metadata.files[1].nextReadWith;
  const next = await client.callTool({ name: tool, arguments: continuation });
  assert.ok(!next.isError);
  assert.equal(next.content.filter((content) => content.type === "image").length, 1);
  assert.equal(JSON.parse(next.content[0].text).files[0].fileIndex, 1);
  const invalid = await client.callTool({ name: tool, arguments: { ...continuation, fileIndex: 10 } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /fileIndex exceeds/);
  assert.ok(paths.includes("/v1/sections/1/assignments/2"));
});

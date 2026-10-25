import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const PDF_ASSETS = dirname(require.resolve("pdfjs-dist/package.json"));
const TEXT_LIMIT = 45000;
const IMAGE_LIMIT = 1000000;

// Full pages preserve vector drawings, chart axes, equations and table layout,
// which are lost both by plain text extraction and embedded-image extraction.
export async function readAttachment(buffer, { startPage = 1, pageCount = 3, includeImages = true } = {}) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  if (!buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    const image = await loadImage(buffer);
    if (image.width * image.height > 16777216) throw new Error("Image exceeds the 16 megapixel limit.");
    if (startPage !== 1) throw new Error("This image has only one page.");
    const scale = Math.min(1, 1800 / Math.max(image.width, image.height));
    const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const images = includeImages ? [encodeImage(canvas, 1)] : [];
    return { text: "", totalPages: 1, textTruncated: false, images, nextPage: null };
  }

  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    maxImageSize: 16777216,
    cMapUrl: join(PDF_ASSETS, "cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: join(PDF_ASSETS, "standard_fonts/"),
    wasmUrl: join(PDF_ASSETS, "wasm/"),
    verbosity: 0,
  });
  try {
    const pdf = await loading.promise;
    if (startPage > pdf.numPages) throw new Error(`startPage exceeds this file's ${pdf.numPages} pages.`);
    let text = "";
    let textTruncated = startPage === 1 && pdf.numPages > 200;
    const images = [];
    const warnings = [];
    const endPage = Math.min(pdf.numPages, startPage + pageCount - 1);
    // Retain the existing whole-document text, but focus text on the requested
    // range when paging so later pages remain reachable beyond the text cap.
    const textStart = startPage === 1 ? 1 : startPage;
    const textEnd = startPage === 1 ? Math.min(200, pdf.numPages) : endPage;
    for (let number = textStart; number <= textEnd; number++) {
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        text += content.items.map((item) => item.str == null ? "" : item.str + (item.hasEOL ? "\n" : " ")).join("") + "\n";
        if (text.length > TEXT_LIMIT) {
          text = text.slice(0, TEXT_LIMIT);
          textTruncated = true;
          break;
        }
      } catch {
        warnings.push(`Could not extract text from page ${number}; inspect its image instead.`);
        textTruncated = true;
      } finally {
        page.cleanup();
      }
    }
    let lastPage = startPage - 1;
    if (includeImages) {
      for (let number = startPage; number <= endPage; number++) {
        const page = await pdf.getPage(number);
        try {
          const original = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(original.width, original.height)) });
          const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
          await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport, background: "white" }).promise;
          images.push(encodeImage(canvas, number));
        } catch {
          warnings.push(`Could not render page ${number}; its visual content is unavailable.`);
          break;
        } finally {
          lastPage = number;
          page.cleanup();
        }
      }
    }
    const nextPage = includeImages ? lastPage < pdf.numPages ? lastPage + 1 : null : endPage < pdf.numPages ? endPage + 1 : null;
    return { text: text.trim(), totalPages: pdf.numPages, textTruncated, images, nextPage, ...(warnings.length ? { warnings } : {}) };
  } finally {
    await loading.destroy();
  }
}

function encodeImage(canvas, page) {
  let bytes = canvas.toBuffer("image/jpeg", 85);
  if (bytes.length > IMAGE_LIMIT) bytes = canvas.toBuffer("image/jpeg", 60);
  if (bytes.length > IMAGE_LIMIT) throw new Error("Rendered page exceeds the 1 MB image limit; request text-only with includeImages=false.");
  return { page, width: canvas.width, height: canvas.height, data: bytes.toString("base64"), mimeType: "image/jpeg" };
}

export async function downloadAttachment(url) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname !== "files-cdn.schoology.com" || target.port || target.username || target.password) {
    throw new Error("Blocked attachment URL outside Schoology's file CDN.");
  }
  // Never send the FCPS cookie jar to a CDN or follow an unvalidated redirect.
  const response = await fetch(target.href, { redirect: "error", signal: AbortSignal.timeout(20000) });
  return readAttachmentResponse(response);
}

export async function readAttachmentResponse(response) {
  if (!response.ok) throw new Error(`Attachment download failed (HTTP ${response.status}).`);
  const limit = 25 * 1024 * 1024;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("Attachment exceeds the 25 MB download limit.");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Attachment exceeds the 25 MB download limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

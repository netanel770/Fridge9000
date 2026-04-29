import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const Y_TOLERANCE = 2;
const MAX_QTY = 99;
const MIN_NAME_LENGTH = 2;
const MIN_TEXT_LENGTH_TO_SKIP_OCR = 30;
const OCR_RENDER_SCALE = 2.5;
const TABLE_HEADER_MIN_HITS = 2;
const NUMBER_PATTERN = /-?\d+(?:[.,]\d+)?/g;
const PURE_NUMBER_PATTERN = /^-?\d+(?:[.,]\d+)?$/;
const DEFAULT_OCR_LANGUAGES = ["heb", "eng"];

const NAME_BLACKLIST_PATTERNS = [
  /^=+$/,
  /^-+$/,
  /^_+$/,
  /^https?:/i,
  /@/,
  /www\./i,
];

const TABLE_HEADER_HINTS = [
  "description",
  "item",
  "items",
  "service",
  "product",
  "qty",
  "quantity",
  "rate",
  "unit",
  "price",
  "amount",
  "total",
  "תיאור",
  "פריט",
  "מוצר",
  "שירות",
  "כמות",
  "מחיר",
  "סכום",
];

const TABLE_END_HINTS = [
  "subtotal",
  "sub-total",
  "sub total",
  "grand total",
  "amount due",
  "balance due",
  "amount paid",
  "total due",
  "tax",
  "vat",
  "gst",
  "discount",
  "thank you",
  "thanks",
  "notes",
  "terms",
  'סה"כ',
  "סך הכל",
  'מע"מ',
  "הנחה",
  "לתשלום",
  "תודה",
];

const NON_ITEM_LINE_PATTERNS = [
  /^(date|time|invoice|receipt|order|bill|due)\b[:#\s]/i,
  /^(phone|tel|fax|email|address|website|customer|client|bill\s*to|ship\s*to)\b[:#\s]?/i,
  /^[+\d\s\-().]{7,}$/,
  /\b(subtotal|sub-total|grand\s*total|amount\s*(due|paid)|balance\s*due|tax|vat|gst|discount)\b/i,
  /thank\s*you/i,
  /\bpage\s+\d+\s*(of|\/)\s*\d+\b/i,
  /\b(st|street|ave|avenue|blvd|rd|road|dr|drive|way|ln|lane|ct|court)\b\.?(?=\s|$)/i,
  /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/,
  /\b(inc|llc|corp|corporation|ltd|company|co)\.?$/i,
  /upload\s+logo/i,
];

/**
 * Read a receipt File (PDF or image) and return raw text + parsed item candidates.
 *
 * @param {File} file
 * @param {{
 *   languages?: string[],
 *   onProgress?: (info: { stage: string, progress: number, message: string }) => void,
 *   forceOcr?: boolean,
 *   tableOnly?: boolean,
 * }} [options]
 */
export async function parseReceiptFile(file, options = {}) {
  if (!file) throw new Error("No file provided");

  const onProgress = options.onProgress || (() => {});
  const languages = options.languages || DEFAULT_OCR_LANGUAGES;
  const tableOnly = options.tableOnly !== false;
  const isImage = file.type?.startsWith("image/");
  const isPdf =
    file.type === "application/pdf" ||
    /\.pdf$/i.test(file.name || "");

  if (!isPdf && !isImage) {
    throw new Error("File must be a PDF or an image");
  }

  if (isImage) {
    onProgress({ stage: "ocr", progress: 0, message: "Running OCR on image..." });
    const lines = await ocrImageSource(file, languages, onProgress);
    return finalize(lines, "ocr", { tableOnly });
  }

  onProgress({ stage: "loading", progress: 0, message: "Loading PDF..." });
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  let textLines = [];
  if (!options.forceOcr) {
    onProgress({
      stage: "extract-text",
      progress: 0,
      message: "Extracting text from PDF...",
    });
    const pageContents = await Promise.all(
      Array.from({ length: pdf.numPages }, (_, idx) =>
        pdf.getPage(idx + 1).then((page) => page.getTextContent()),
      ),
    );
    for (const content of pageContents) {
      textLines.push(...groupItemsToLines(content.items));
    }
  }

  const textJoined = textLines.join("").replace(/\s+/g, "");
  if (!options.forceOcr && textJoined.length >= MIN_TEXT_LENGTH_TO_SKIP_OCR) {
    return finalize(textLines, "pdf-text", { tableOnly });
  }

  onProgress({
    stage: "ocr",
    progress: 0,
    message:
      "PDF has no embedded text, running OCR (first run downloads language data)...",
  });
  const ocrLines = await ocrPdfPages(pdf, languages, onProgress);
  return finalize(ocrLines, "ocr", { tableOnly });
}

function finalize(lines, source, { tableOnly }) {
  const cleaned = lines.map((l) => l.trim()).filter(Boolean);
  const tableSection = tableOnly ? findTableSection(cleaned) : null;

  const workingLines = tableSection
    ? cleaned.slice(tableSection.start, tableSection.end)
    : cleaned;

  const items = extractItemCandidates(workingLines, { tableDetected: !!tableSection });

  return {
    rawText: cleaned.join("\n"),
    lines: cleaned,
    items,
    source,
    tableDetected: !!tableSection,
    tableRange: tableSection,
  };
}

/**
 * Find the inclusive index range of the items table.
 *
 * Strategy:
 *   1. Locate the end of the table (Subtotal / Total / Tax line).
 *   2. Within [0, endIdx) look for a real header row — a line that contains
 *      ≥2 header keywords AND no numeric tokens (a real header is just labels;
 *      an item row like "2 Custom product/service A 45.00 $90.00" has numbers).
 *   3. If a header is found → range = [headerIdx+1, endIdx).
 *      Otherwise          → range = [0, endIdx) (let line filters reject the
 *                            non-item rows above the items).
 *   4. If neither a header nor an end-marker is found → return null and the
 *      caller falls back to scanning all lines.
 */
function findTableSection(lines) {
  let endIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (TABLE_END_HINTS.some((hint) => lower.includes(hint))) {
      endIdx = i;
      break;
    }
  }

  const searchEnd = endIdx >= 0 ? endIdx : lines.length;
  let headerIdx = -1;
  for (let i = 0; i < searchEnd; i++) {
    const line = lines[i];
    if (lineHasNumericData(line)) continue;

    const lower = line.toLowerCase();
    let hits = 0;
    for (const hint of TABLE_HEADER_HINTS) {
      if (lower.includes(hint)) {
        hits++;
        if (hits >= TABLE_HEADER_MIN_HITS) break;
      }
    }
    if (hits >= TABLE_HEADER_MIN_HITS) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx >= 0) {
    const end = endIdx >= 0 ? endIdx : lines.length;
    if (end <= headerIdx + 1) return null;
    return { start: headerIdx + 1, end };
  }

  if (endIdx > 0) {
    return { start: 0, end: endIdx };
  }

  return null;
}

function lineHasNumericData(line) {
  const tokens = line.split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    const cleaned = t.replace(/[$€₪£,]/g, "");
    if (PURE_NUMBER_PATTERN.test(cleaned)) return true;
  }
  return false;
}

async function ocrPdfPages(pdf, languages, onProgress) {
  const allLines = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to acquire 2D canvas context");

    await page.render({
      canvasContext: ctx,
      canvas,
      viewport,
    }).promise;

    const lines = await ocrCanvas(canvas, languages, (info) =>
      onProgress({
        ...info,
        message: `OCR page ${i}/${pdf.numPages}: ${info.message}`,
      }),
    );
    allLines.push(...lines);
  }
  return allLines;
}

async function ocrImageSource(file, languages, onProgress) {
  const url = URL.createObjectURL(file);
  try {
    return await ocrCanvas(url, languages, onProgress);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function ocrCanvas(source, languages, onProgress) {
  const Tesseract = await import("tesseract.js");
  const langString = languages.join("+");
  const result = await Tesseract.recognize(source, langString, {
    logger: (m) => {
      if (typeof m.progress === "number") {
        onProgress({
          stage: m.status || "ocr",
          progress: m.progress,
          message: m.status || "Processing...",
        });
      }
    },
  });

  const data = result?.data;
  if (!data) return [];

  if (Array.isArray(data.lines) && data.lines.length > 0) {
    return data.lines
      .map((l) => (l?.text || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  return (data.text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function groupItemsToLines(items) {
  if (!items || items.length === 0) return [];

  const enriched = items
    .filter((it) => typeof it.str === "string" && it.str.trim().length > 0)
    .map((it) => {
      const transform = it.transform || [1, 0, 0, 1, 0, 0];
      return {
        text: it.str,
        x: transform[4],
        y: transform[5],
      };
    });

  enriched.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  let current = null;
  for (const item of enriched) {
    if (current && Math.abs(current.y - item.y) <= Y_TOLERANCE) {
      current.parts.push(item);
    } else {
      if (current) lines.push(current);
      current = { y: item.y, parts: [item] };
    }
  }
  if (current) lines.push(current);

  return lines.map((line) => {
    const sorted = [...line.parts].sort((a, b) => a.x - b.x);
    return sorted
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  });
}

function classifyLineParts(line) {
  const tokens = line.split(/\s+/).filter(Boolean);
  const numbers = [];
  const names = [];
  for (const t of tokens) {
    const cleaned = t.replace(/[$€₪£,]/g, "");
    if (PURE_NUMBER_PATTERN.test(cleaned)) {
      numbers.push(parseFloat(cleaned));
    } else if (!NUMBER_PATTERN.test(cleaned)) {
      names.push(t);
    }
  }
  return { numbers, nameStr: names.join(" ").trim() };
}

/**
 * Walk lines and stitch together adjacent fragments that belong to the same
 * logical table row. This handles three common OCR layouts:
 *  - "Name qty price total" all on one line.
 *  - Name on one line, qty/price/total on the next line.
 *  - Each cell on its own line (multi-line splits).
 */
function stitchRows(lines) {
  const rows = [];
  let buffer = null;

  const flushBuffer = () => {
    if (
      buffer &&
      buffer.nameStr.length >= MIN_NAME_LENGTH &&
      buffer.numbers.length > 0
    ) {
      rows.push(buffer);
    }
    buffer = null;
  };

  for (const raw of lines) {
    if (!raw) continue;
    if (NAME_BLACKLIST_PATTERNS.some((re) => re.test(raw))) continue;
    if (NON_ITEM_LINE_PATTERNS.some((re) => re.test(raw))) continue;

    const { numbers, nameStr } = classifyLineParts(raw);
    const hasName = nameStr.length >= MIN_NAME_LENGTH;
    const hasNumbers = numbers.length > 0;

    if (hasName && hasNumbers) {
      flushBuffer();
      buffer = { nameStr, numbers: [...numbers], raw };
      flushBuffer();
    } else if (hasName && !hasNumbers) {
      if (buffer && buffer.numbers.length === 0) {
        buffer.nameStr = `${buffer.nameStr} ${nameStr}`.trim();
        buffer.raw = `${buffer.raw} | ${raw}`;
      } else {
        flushBuffer();
        buffer = { nameStr, numbers: [], raw };
      }
    } else if (!hasName && hasNumbers) {
      if (buffer) {
        buffer.numbers.push(...numbers);
        buffer.raw = `${buffer.raw} | ${raw}`;
      }
    }
  }
  flushBuffer();
  return rows;
}

const ALL_CAPS_HEADER_PATTERN = /^[A-Z\s]{6,}$/;

function extractItemCandidates(lines, { tableDetected }) {
  const rows = stitchRows(lines);
  const items = [];

  for (const r of rows) {
    if (!tableDetected && ALL_CAPS_HEADER_PATTERN.test(r.nameStr)) continue;

    let qty = 1;
    let maxPositive = 0;
    let foundQty = false;
    for (const n of r.numbers) {
      if (n <= 0) continue;
      if (n > maxPositive) maxPositive = n;
      if (!foundQty && Number.isInteger(n) && n >= 1 && n <= MAX_QTY) {
        qty = n;
        foundQty = true;
      }
    }

    items.push({
      name: r.nameStr,
      quantity: qty,
      price: maxPositive > 0 ? maxPositive : null,
      raw: r.raw,
    });
  }

  return dedupeItems(items);
}

function dedupeItems(items) {
  const map = new Map();
  for (const it of items) {
    const key = it.name.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.quantity += it.quantity;
    } else {
      map.set(key, { ...it });
    }
  }
  return Array.from(map.values());
}

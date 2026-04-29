import type {
  ParseResult,
  ParsedReceiptItem,
  TableRange,
} from "../types/receipt";

const MAX_QTY = 99;
const MIN_NAME_LENGTH = 2;
const TABLE_HEADER_MIN_HITS = 2;

const NUMBER_PATTERN = /-?\d+(?:[.,]\d+)?/g;
const PURE_NUMBER_PATTERN = /^-?\d+(?:[.,]\d+)?$/;
const ALL_CAPS_HEADER_PATTERN = /^[A-Z\s]{6,}$/;

const NAME_BLACKLIST_PATTERNS: readonly RegExp[] = [
  /^=+$/,
  /^-+$/,
  /^_+$/,
  /^https?:/i,
  /@/,
  /www\./i,
];

const TABLE_HEADER_HINTS: readonly string[] = [
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

const TABLE_END_HINTS: readonly string[] = [
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

const NON_ITEM_LINE_PATTERNS: readonly RegExp[] = [
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

type Row = { nameStr: string; numbers: number[]; raw: string };

/**
 * Run receipt heuristics over a list of OCR'd / extracted lines.
 *
 * Strategy mirrors the web implementation:
 *  1. Optionally detect a "products table" section using header/footer hints.
 *  2. Stitch fragmented OCR lines back into logical rows.
 *  3. From each row, pick a quantity (smallest int 1..99) and a price (max
 *     positive number) and dedupe by case-insensitive name.
 */
export function parseLines(
  rawLines: readonly string[],
  options: { tableOnly?: boolean } = {},
): ParseResult {
  const tableOnly = options.tableOnly !== false;

  const cleaned: string[] = [];
  for (const l of rawLines) {
    const t = l.trim();
    if (t.length > 0) cleaned.push(t);
  }

  const tableRange = tableOnly ? findTableSection(cleaned) : null;
  const workingLines = tableRange
    ? cleaned.slice(tableRange.start, tableRange.end)
    : cleaned;

  const items = extractItemCandidates(workingLines, {
    tableDetected: !!tableRange,
  });

  return {
    rawText: cleaned.join("\n"),
    lines: cleaned,
    items,
    tableDetected: !!tableRange,
    tableRange,
  };
}

function findTableSection(lines: readonly string[]): TableRange | null {
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

function lineHasNumericData(line: string): boolean {
  const tokens = line.split(/\s+/);
  for (const t of tokens) {
    if (!t) continue;
    const cleaned = t.replace(/[$€₪£,]/g, "");
    if (PURE_NUMBER_PATTERN.test(cleaned)) return true;
  }
  return false;
}

function classifyLineParts(line: string): { numbers: number[]; nameStr: string } {
  const tokens = line.split(/\s+/);
  const numbers: number[] = [];
  const names: string[] = [];
  for (const t of tokens) {
    if (!t) continue;
    const cleaned = t.replace(/[$€₪£,]/g, "");
    if (PURE_NUMBER_PATTERN.test(cleaned)) {
      numbers.push(parseFloat(cleaned));
    } else if (!NUMBER_PATTERN.test(cleaned)) {
      names.push(t);
    }
  }
  return { numbers, nameStr: names.join(" ").trim() };
}

function stitchRows(lines: readonly string[]): Row[] {
  const rows: Row[] = [];
  let buffer: Row | null = null;

  const flush = () => {
    if (
      buffer &&
      buffer.nameStr.length >= MIN_NAME_LENGTH &&
      buffer.numbers.length > 0
    ) {
      rows.push(buffer);
    }
    buffer = null;
  };

  outer: for (const raw of lines) {
    if (!raw) continue;
    for (const re of NAME_BLACKLIST_PATTERNS) if (re.test(raw)) continue outer;
    for (const re of NON_ITEM_LINE_PATTERNS) if (re.test(raw)) continue outer;

    const { numbers, nameStr } = classifyLineParts(raw);
    const hasName = nameStr.length >= MIN_NAME_LENGTH;
    const hasNumbers = numbers.length > 0;

    if (hasName && hasNumbers) {
      flush();
      buffer = { nameStr, numbers: numbers.slice(), raw };
      flush();
    } else if (hasName) {
      if (buffer && buffer.numbers.length === 0) {
        buffer.nameStr = `${buffer.nameStr} ${nameStr}`.trim();
        buffer.raw = `${buffer.raw} | ${raw}`;
      } else {
        flush();
        buffer = { nameStr, numbers: [], raw };
      }
    } else if (hasNumbers && buffer) {
      buffer.numbers.push(...numbers);
      buffer.raw = `${buffer.raw} | ${raw}`;
    }
  }
  flush();
  return rows;
}

function extractItemCandidates(
  lines: readonly string[],
  { tableDetected }: { tableDetected: boolean },
): ParsedReceiptItem[] {
  const rows = stitchRows(lines);
  const items: ParsedReceiptItem[] = [];

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

function dedupeItems(items: readonly ParsedReceiptItem[]): ParsedReceiptItem[] {
  const map = new Map<string, ParsedReceiptItem>();
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

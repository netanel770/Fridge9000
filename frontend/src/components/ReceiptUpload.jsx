import {
  memo,
  startTransition,
  useCallback,
  useMemo,
  useState,
} from "react";
import { parseReceiptFile } from "../services/receiptParser.js";
import { addInventoryItem } from "../services/inventoryApi.js";

const styles = {
  container: {},
  fileInput: { marginBottom: 12 },
  primaryBtn: {
    padding: "10px 16px",
    backgroundColor: "#3b82f6",
    color: "white",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    width: "100%",
  },
  successBtn: {
    padding: "10px 16px",
    backgroundColor: "#10b981",
    color: "white",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
  },
  ghostBtn: {
    padding: "6px 12px",
    background: "#e2e8f0",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
  },
  outlineBtn: {
    padding: "6px 10px",
    background: "transparent",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 12,
  },
  table: { width: "100%", borderCollapse: "collapse", marginTop: 12 },
  th: { borderBottom: "1px solid #ddd", padding: 8, textAlign: "left" },
  td: { padding: 8, borderBottom: "1px solid #f1f5f9" },
  tdCenter: {
    padding: 8,
    borderBottom: "1px solid #f1f5f9",
    textAlign: "center",
  },
  inputName: { padding: 4, width: "95%" },
  inputQty: { padding: 4, width: 70 },
  errorBox: {
    padding: 10,
    marginTop: 12,
    backgroundColor: "#fee2e2",
    color: "#b91c1c",
    borderRadius: 6,
    fontSize: 14,
  },
  successBox: {
    padding: 10,
    marginTop: 12,
    backgroundColor: "#dcfce7",
    color: "#166534",
    borderRadius: 6,
    fontSize: 14,
  },
  rawBox: {
    width: "100%",
    minHeight: 120,
    marginTop: 12,
    fontFamily: "monospace",
    fontSize: 12,
    padding: 8,
    border: "1px solid #ddd",
    borderRadius: 6,
    whiteSpace: "pre-wrap",
    direction: "auto",
  },
  toolbar: { display: "flex", gap: 8, alignItems: "center", marginTop: 12 },
  hint: { fontSize: 12, color: "#64748b", marginTop: 4 },
  rawBoxLegend: { fontSize: 11, color: "#64748b", marginTop: 4 },
  progressWrap: {
    marginTop: 12,
    border: "1px solid #e2e8f0",
    borderRadius: 6,
    padding: 8,
    fontSize: 13,
  },
  progressLabel: { color: "#64748b" },
  progressBarOuter: {
    height: 8,
    backgroundColor: "#e2e8f0",
    borderRadius: 4,
    overflow: "hidden",
    marginTop: 6,
  },
  progressBarInnerBase: {
    height: "100%",
    backgroundColor: "#3b82f6",
    transition: "width 120ms linear",
  },
  optionsRow: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    marginTop: 8,
    flexWrap: "wrap",
    fontSize: 13,
  },
  optionLabel: { display: "flex", alignItems: "center", gap: 6 },
  badge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    marginLeft: 8,
  },
  itemsHeader: { marginTop: 16, fontSize: 13 },
  rawWrapper: { marginTop: 16 },
  primaryBtnDisabled: {
    padding: "10px 16px",
    backgroundColor: "#3b82f6",
    color: "white",
    border: "none",
    borderRadius: 6,
    cursor: "not-allowed",
    width: "100%",
    opacity: 0.6,
  },
  successBtnDisabled: {
    padding: "10px 16px",
    backgroundColor: "#10b981",
    color: "white",
    border: "none",
    borderRadius: 6,
    cursor: "not-allowed",
    opacity: 0.6,
  },
};

const SOURCE_BADGE = {
  "pdf-text": { label: "PDF text", bg: "#dbeafe", fg: "#1e40af" },
  ocr: { label: "OCR", bg: "#fef3c7", fg: "#92400e" },
};

const TABLE_FOUND_BADGE = { bg: "#dcfce7", fg: "#166534", label: "table found" };
const TABLE_MISSING_BADGE = { bg: "#fee2e2", fg: "#b91c1c", label: "no table found" };

const sourceBadgeStyles = new Map();
function getSourceBadgeStyle(source) {
  const def = SOURCE_BADGE[source];
  if (!def) return null;
  let cached = sourceBadgeStyles.get(source);
  if (!cached) {
    cached = { ...styles.badge, backgroundColor: def.bg, color: def.fg };
    sourceBadgeStyles.set(source, cached);
  }
  return { style: cached, label: def.label };
}

const tableFoundStyle = {
  ...styles.badge,
  backgroundColor: TABLE_FOUND_BADGE.bg,
  color: TABLE_FOUND_BADGE.fg,
};
const tableMissingStyle = {
  ...styles.badge,
  backgroundColor: TABLE_MISSING_BADGE.bg,
  color: TABLE_MISSING_BADGE.fg,
};

const ReceiptItemRow = memo(function ReceiptItemRow({
  index,
  included,
  name,
  quantity,
  price,
  onUpdate,
}) {
  const handleIncluded = useCallback(
    (e) => onUpdate(index, "included", e.target.checked),
    [index, onUpdate],
  );
  const handleName = useCallback(
    (e) => onUpdate(index, "name", e.target.value),
    [index, onUpdate],
  );
  const handleQty = useCallback(
    (e) =>
      onUpdate(
        index,
        "quantity",
        Math.max(1, parseInt(e.target.value, 10) || 1),
      ),
    [index, onUpdate],
  );

  return (
    <tr>
      <td style={styles.tdCenter}>
        <input type="checkbox" checked={included} onChange={handleIncluded} />
      </td>
      <td style={styles.td}>
        <input value={name} onChange={handleName} style={styles.inputName} />
      </td>
      <td style={styles.td}>
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={handleQty}
          style={styles.inputQty}
        />
      </td>
      <td style={styles.td}>{price != null ? price.toFixed(2) : "-"}</td>
    </tr>
  );
});

function buildItemsFromParsed(parsed) {
  const next = new Array(parsed.length);
  for (let i = 0; i < parsed.length; i++) {
    const it = parsed[i];
    next[i] = {
      name: it.name,
      quantity: it.quantity,
      price: it.price,
      included: true,
    };
  }
  return next;
}

function emptyInfoForResult(parsed, src, tableOnly, tableFound) {
  if (parsed.length > 0) return "";
  if (tableOnly && !tableFound) {
    return "No product table detected. Untick 'Only items in product table' to scan all lines, or add rows manually.";
  }
  if (src === "ocr") {
    return "OCR finished but no item rows were detected. Check the raw text and add rows manually.";
  }
  return "No items detected. Try enabling 'Force OCR' if the PDF is scanned.";
}

export default function ReceiptUpload({ onSubmitted }) {
  const [file, setFile] = useState(null);
  const [items, setItems] = useState([]);
  const [rawText, setRawText] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [progress, setProgress] = useState(null);
  const [forceOcr, setForceOcr] = useState(false);
  const [tableOnly, setTableOnly] = useState(true);
  const [source, setSource] = useState(null);
  const [tableDetected, setTableDetected] = useState(false);
  const [allLines, setAllLines] = useState([]);
  const [tableRange, setTableRange] = useState(null);

  const includedCount = useMemo(() => {
    let n = 0;
    for (const it of items) if (it.included) n++;
    return n;
  }, [items]);

  const handleFileChange = useCallback((e) => {
    setError("");
    setInfo("");
    setItems([]);
    setRawText("");
    setSource(null);
    setTableDetected(false);
    setAllLines([]);
    setTableRange(null);
    setFile(e.target.files?.[0] ?? null);
  }, []);

  const handleProgress = useCallback((p) => {
    startTransition(() => setProgress(p));
  }, []);

  const handleParse = useCallback(async () => {
    if (!file) return;
    setError("");
    setInfo("");
    setProgress(null);
    setParsing(true);
    try {
      const result = await parseReceiptFile(file, {
        forceOcr,
        tableOnly,
        onProgress: handleProgress,
      });
      setRawText(result.rawText);
      setSource(result.source);
      setTableDetected(result.tableDetected);
      setAllLines(result.lines || []);
      setTableRange(result.tableRange || null);
      setItems(buildItemsFromParsed(result.items));

      const message = emptyInfoForResult(
        result.items,
        result.source,
        tableOnly,
        result.tableDetected,
      );
      if (message) setInfo(message);
    } catch (e) {
      setError(`Failed to parse: ${e.message}`);
    } finally {
      setParsing(false);
      setProgress(null);
    }
  }, [file, forceOcr, tableOnly, handleProgress]);

  const updateItem = useCallback((idx, field, value) => {
    setItems((prev) => {
      const next = prev.slice();
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }, []);

  const addEmptyRow = useCallback(() => {
    setItems((prev) =>
      prev.concat({ name: "", quantity: 1, price: null, included: true }),
    );
  }, []);

  const handleSubmit = useCallback(async () => {
    setError("");
    setInfo("");
    setSubmitting(true);
    try {
      const toSubmit = [];
      for (const it of items) {
        const trimmed = it.name.trim();
        if (it.included && trimmed && it.quantity > 0) {
          toSubmit.push({ name: trimmed, quantity: Number(it.quantity) });
        }
      }
      if (toSubmit.length === 0) {
        setError("No valid items selected.");
        return;
      }
      const results = await Promise.allSettled(
        toSubmit.map((it) => addInventoryItem(it.name, it.quantity)),
      );
      let failedCount = 0;
      for (const r of results) {
        if (r.status === "rejected") failedCount++;
      }
      if (failedCount > 0) {
        setError(`${failedCount} item(s) failed to add.`);
      } else {
        setInfo(`Added ${toSubmit.length} item(s) to inventory.`);
        setItems([]);
        setFile(null);
        setRawText("");
        setSource(null);
        setTableDetected(false);
        setAllLines([]);
        setTableRange(null);
      }
      onSubmitted?.();
    } catch (e) {
      setError(`Submit failed: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  }, [items, onSubmitted]);

  const toggleShowRaw = useCallback(() => setShowRaw((v) => !v), []);

  const onTableOnlyChange = useCallback(
    (e) => setTableOnly(e.target.checked),
    [],
  );
  const onForceOcrChange = useCallback(
    (e) => setForceOcr(e.target.checked),
    [],
  );

  const parseDisabled = !file || parsing;
  const submitDisabled = submitting || includedCount === 0;
  const sourceBadge = getSourceBadgeStyle(source);
  const progressPercent = progress
    ? Math.round((progress.progress || 0) * 100)
    : 0;
  const progressBarInnerStyle = useMemo(
    () => ({ ...styles.progressBarInnerBase, width: `${progressPercent}%` }),
    [progressPercent],
  );
  const rawDisplay = useMemo(() => {
    if (allLines.length === 0) return rawText;
    const out = [];
    for (let idx = 0; idx < allLines.length; idx++) {
      const inTable =
        tableRange && idx >= tableRange.start && idx < tableRange.end;
      const marker = inTable ? "▶" : " ";
      out.push(`${marker} ${String(idx).padStart(3, " ")}: ${allLines[idx]}`);
    }
    return out.join("\n");
  }, [allLines, rawText, tableRange]);

  return (
    <div style={styles.container}>
      <input
        type="file"
        accept="application/pdf,.pdf,image/*"
        onChange={handleFileChange}
        style={styles.fileInput}
      />
      <button
        onClick={handleParse}
        disabled={parseDisabled}
        style={parseDisabled ? styles.primaryBtnDisabled : styles.primaryBtn}
      >
        {parsing ? "Parsing..." : "📄 Parse Receipt"}
      </button>

      <div style={styles.optionsRow}>
        <label style={styles.optionLabel}>
          <input
            type="checkbox"
            checked={tableOnly}
            onChange={onTableOnlyChange}
          />
          Only items in product table
        </label>
        <label style={styles.optionLabel}>
          <input
            type="checkbox"
            checked={forceOcr}
            onChange={onForceOcrChange}
          />
          Force OCR (use for scanned / image PDFs)
        </label>
      </div>

      <p style={styles.hint}>
        Upload a receipt PDF or image. Text-based PDFs are read instantly.
        Scanned PDFs and images use OCR (Hebrew + English) — first run downloads
        ~25MB of language data from the CDN, after that it's cached.
      </p>

      {progress ? (
        <div style={styles.progressWrap}>
          <div>
            <strong>{progress.stage}</strong>: {progress.message}{" "}
            <span style={styles.progressLabel}>{progressPercent}%</span>
          </div>
          <div style={styles.progressBarOuter}>
            <div style={progressBarInnerStyle} />
          </div>
        </div>
      ) : null}

      {error ? <div style={styles.errorBox}>⚠️ {error}</div> : null}
      {info ? <div style={styles.successBox}>✅ {info}</div> : null}

      {items.length > 0 ? (
        <>
          <div style={styles.itemsHeader}>
            <strong>Detected items:</strong> {items.length}
            {sourceBadge ? (
              <span style={sourceBadge.style}>via {sourceBadge.label}</span>
            ) : null}
            {tableOnly ? (
              <span
                style={tableDetected ? tableFoundStyle : tableMissingStyle}
              >
                {tableDetected
                  ? TABLE_FOUND_BADGE.label
                  : TABLE_MISSING_BADGE.label}
              </span>
            ) : null}
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Include</th>
                <th style={styles.th}>Item</th>
                <th style={styles.th}>Qty</th>
                <th style={styles.th}>Price</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <ReceiptItemRow
                  key={idx}
                  index={idx}
                  included={it.included}
                  name={it.name}
                  quantity={it.quantity}
                  price={it.price}
                  onUpdate={updateItem}
                />
              ))}
            </tbody>
          </table>

          <div style={styles.toolbar}>
            <button onClick={addEmptyRow} style={styles.ghostBtn}>
              ➕ Add row
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitDisabled}
              style={
                submitDisabled ? styles.successBtnDisabled : styles.successBtn
              }
            >
              {submitting
                ? "Submitting..."
                : `✅ Add ${includedCount} item(s) to Inventory`}
            </button>
          </div>
        </>
      ) : null}

      {rawText ? (
        <div style={styles.rawWrapper}>
          <button onClick={toggleShowRaw} style={styles.outlineBtn}>
            {showRaw ? "Hide raw text" : "Show raw text"}
          </button>
          {showRaw ? <pre style={styles.rawBox}>{rawDisplay}</pre> : null}
          {tableRange && showRaw ? (
            <div style={styles.rawBoxLegend}>
              ▶ marks lines inside the detected products table (lines{" "}
              {tableRange.start}–{tableRange.end - 1}).
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

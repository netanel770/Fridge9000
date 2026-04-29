import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as ImagePicker from "expo-image-picker";
import { addInventoryItem } from "../../services/api";
import { parseLines } from "../../services/receiptParser";
import {
  defaultOcrProvider,
  type OcrProvider,
} from "../../services/receiptOcr";
import { ReceiptOcrError } from "../../types/receipt";
import type {
  EditableReceiptItem,
  OcrProgress,
  ParseResult,
  ReceiptItemSource,
  TableRange,
} from "../../types/receipt";

export type ReceiptUploadState = {
  pickedUri: string | null;
  pickedMime: string | null;
  pickedName: string | null;
  items: EditableReceiptItem[];
  rawText: string;
  allLines: string[];
  parsing: boolean;
  submitting: boolean;
  error: string;
  info: string;
  progress: OcrProgress | null;
  source: ReceiptItemSource | null;
  tableOnly: boolean;
  tableDetected: boolean;
  tableRange: TableRange | null;
  showRaw: boolean;
};

export type ReceiptUploadHandlers = {
  pickFromGallery: () => Promise<void>;
  takePhoto: () => Promise<void>;
  parse: () => Promise<void>;
  cancel: () => void;
  setTableOnly: (value: boolean) => void;
  toggleShowRaw: () => void;
  updateItem: (
    id: string,
    field: "name" | "quantity" | "included",
    value: string | number | boolean,
  ) => void;
  removeItem: (id: string) => void;
  addEmptyRow: () => void;
  submit: () => Promise<void>;
};

export type ReceiptUploadDerived = {
  parseDisabled: boolean;
  submitDisabled: boolean;
  includedCount: number;
  rawDisplay: string;
};

export type UseReceiptUploadResult = {
  state: ReceiptUploadState;
  handlers: ReceiptUploadHandlers;
  derived: ReceiptUploadDerived;
};

type Options = {
  ocrProvider?: OcrProvider;
  onSubmitted?: () => void;
};

let rowIdCounter = 0;
function nextRowId(): string {
  rowIdCounter += 1;
  return `r${rowIdCounter}`;
}

function buildInitialItems(parsed: ParseResult["items"]): EditableReceiptItem[] {
  const out = new Array<EditableReceiptItem>(parsed.length);
  for (let i = 0; i < parsed.length; i++) {
    const it = parsed[i];
    out[i] = {
      id: nextRowId(),
      name: it.name,
      quantity: it.quantity,
      price: it.price,
      included: true,
    };
  }
  return out;
}

function emptyInfoMessage(
  itemsCount: number,
  source: ReceiptItemSource | null,
  tableOnly: boolean,
  tableFound: boolean,
): string {
  if (itemsCount > 0) return "";
  if (tableOnly && !tableFound) {
    return "No product table detected. Disable 'Only items in product table' to scan all lines, or add rows manually.";
  }
  if (source === "ocr") {
    return "OCR finished but no item rows were detected. Tap 'Show raw text' to inspect, or add rows manually.";
  }
  return "No items detected. Add rows manually if needed.";
}

export function useReceiptUpload(
  options: Options = {},
): UseReceiptUploadResult {
  const ocrProvider = options.ocrProvider ?? defaultOcrProvider;
  const onSubmitted = options.onSubmitted;
  const onSubmittedRef = useRef(onSubmitted);
  useEffect(() => {
    onSubmittedRef.current = onSubmitted;
  }, [onSubmitted]);

  const [pickedUri, setPickedUri] = useState<string | null>(null);
  const [pickedMime, setPickedMime] = useState<string | null>(null);
  const [pickedName, setPickedName] = useState<string | null>(null);
  const [items, setItems] = useState<EditableReceiptItem[]>([]);
  const [rawText, setRawText] = useState("");
  const [allLines, setAllLines] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [source, setSource] = useState<ReceiptItemSource | null>(null);
  const [tableOnly, setTableOnly] = useState(true);
  const [tableDetected, setTableDetected] = useState(false);
  const [tableRange, setTableRange] = useState<TableRange | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const clearResults = useCallback(() => {
    setItems([]);
    setRawText("");
    setAllLines([]);
    setSource(null);
    setTableDetected(false);
    setTableRange(null);
    setError("");
    setInfo("");
  }, []);

  const pickFromGallery = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 0.85,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      clearResults();
      setPickedUri(asset.uri);
      setPickedMime(asset.mimeType ?? "image/jpeg");
      setPickedName(asset.fileName ?? null);
    } catch (e) {
      setError(`Could not pick image: ${describe(e)}`);
    }
  }, [clearResults]);

  const takePhoto = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setError("Camera permission denied");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 0.85,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      clearResults();
      setPickedUri(asset.uri);
      setPickedMime(asset.mimeType ?? "image/jpeg");
      setPickedName(asset.fileName ?? null);
    } catch (e) {
      setError(`Could not capture photo: ${describe(e)}`);
    }
  }, [clearResults]);

  const handleProgress = useCallback((p: OcrProgress) => {
    startTransition(() => setProgress(p));
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const parse = useCallback(async () => {
    if (!pickedUri) return;
    setError("");
    setInfo("");
    setProgress(null);
    setParsing(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const lines = await ocrProvider.recognize(
        {
          uri: pickedUri,
          mimeType: pickedMime ?? undefined,
          fileName: pickedName ?? undefined,
        },
        {
          onProgress: handleProgress,
          signal: controller.signal,
        },
      );
      if (!mountedRef.current) return;

      const parsed = parseLines(lines, { tableOnly });
      if (!mountedRef.current) return;

      setRawText(parsed.rawText);
      setAllLines(parsed.lines);
      setTableDetected(parsed.tableDetected);
      setTableRange(parsed.tableRange);
      setSource("ocr");
      setItems(buildInitialItems(parsed.items));

      const message = emptyInfoMessage(
        parsed.items.length,
        "ocr",
        tableOnly,
        parsed.tableDetected,
      );
      if (message) setInfo(message);
    } catch (e) {
      if (!mountedRef.current) return;
      if (e instanceof ReceiptOcrError) {
        if (e.kind === "cancelled") {
          setInfo("OCR cancelled.");
        } else if (e.kind === "unavailable") {
          setError(e.message);
        } else {
          setError(`OCR failed: ${e.message}`);
        }
      } else {
        setError(`Parse failed: ${describe(e)}`);
      }
    } finally {
      if (mountedRef.current) {
        setParsing(false);
        setProgress(null);
      }
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [pickedUri, pickedMime, pickedName, ocrProvider, tableOnly, handleProgress]);

  const updateItem = useCallback(
    (
      id: string,
      field: "name" | "quantity" | "included",
      value: string | number | boolean,
    ) => {
      setItems((prev) => {
        const next = prev.slice();
        for (let i = 0; i < next.length; i++) {
          if (next[i].id === id) {
            next[i] = { ...next[i], [field]: value } as EditableReceiptItem;
            break;
          }
        }
        return next;
      });
    },
    [],
  );

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const addEmptyRow = useCallback(() => {
    setItems((prev) =>
      prev.concat({
        id: nextRowId(),
        name: "",
        quantity: 1,
        price: null,
        included: true,
      }),
    );
  }, []);

  const submit = useCallback(async () => {
    setError("");
    setInfo("");
    setSubmitting(true);
    try {
      const toSubmit: { name: string; quantity: number }[] = [];
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
        setPickedUri(null);
        setPickedMime(null);
        setPickedName(null);
        setRawText("");
        setAllLines([]);
        setSource(null);
        setTableDetected(false);
        setTableRange(null);
      }
      onSubmittedRef.current?.();
    } catch (e) {
      setError(`Submit failed: ${describe(e)}`);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [items]);

  const toggleShowRaw = useCallback(() => setShowRaw((v) => !v), []);

  const setTableOnlyHandler = useCallback((value: boolean) => {
    setTableOnly(value);
  }, []);

  const includedCount = useMemo(() => {
    let n = 0;
    for (const it of items) if (it.included) n++;
    return n;
  }, [items]);

  const rawDisplay = useMemo(() => {
    if (allLines.length === 0) return rawText;
    const out = new Array<string>(allLines.length);
    for (let idx = 0; idx < allLines.length; idx++) {
      const inTable =
        tableRange !== null &&
        idx >= tableRange.start &&
        idx < tableRange.end;
      const marker = inTable ? "▶" : " ";
      out[idx] = `${marker} ${String(idx).padStart(3, " ")}: ${allLines[idx]}`;
    }
    return out.join("\n");
  }, [allLines, rawText, tableRange]);

  const parseDisabled = !pickedUri || parsing;
  const submitDisabled = submitting || includedCount === 0;

  const state: ReceiptUploadState = {
    pickedUri,
    pickedMime,
    pickedName,
    items,
    rawText,
    allLines,
    parsing,
    submitting,
    error,
    info,
    progress,
    source,
    tableOnly,
    tableDetected,
    tableRange,
    showRaw,
  };

  const handlers: ReceiptUploadHandlers = {
    pickFromGallery,
    takePhoto,
    parse,
    cancel,
    setTableOnly: setTableOnlyHandler,
    toggleShowRaw,
    updateItem,
    removeItem,
    addEmptyRow,
    submit,
  };

  const derived: ReceiptUploadDerived = {
    parseDisabled,
    submitDisabled,
    includedCount,
    rawDisplay,
  };

  return { state, handlers, derived };
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

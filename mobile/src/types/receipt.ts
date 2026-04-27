export type ReceiptItemSource = "ocr" | "manual";

export type ParsedReceiptItem = {
  name: string;
  quantity: number;
  price: number | null;
  raw?: string;
};

export type TableRange = { start: number; end: number };

export type ParseResult = {
  rawText: string;
  lines: string[];
  items: ParsedReceiptItem[];
  tableDetected: boolean;
  tableRange: TableRange | null;
};

export type EditableReceiptItem = {
  id: string;
  name: string;
  quantity: number;
  price: number | null;
  included: boolean;
};

export type OcrProgress = {
  stage: string;
  progress: number;
  message: string;
};

export type OcrResult = {
  lines: string[];
  source: ReceiptItemSource;
};

export type OcrError =
  | "unavailable"
  | "network"
  | "cancelled"
  | "unauthorized"
  | "unknown";

export class ReceiptOcrError extends Error {
  readonly kind: OcrError;
  constructor(kind: OcrError, message: string) {
    super(message);
    this.kind = kind;
    this.name = "ReceiptOcrError";
  }
}

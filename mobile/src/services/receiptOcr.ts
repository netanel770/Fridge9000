import { API_BASE_URL } from "./config";
import { ReceiptOcrError } from "../types/receipt";
import type { OcrProgress } from "../types/receipt";

export type OcrInput = {
  uri: string;
  mimeType?: string;
  fileName?: string;
};

export type OcrOptions = {
  languages?: readonly string[];
  onProgress?: (info: OcrProgress) => void;
  signal?: AbortSignal;
};

export interface OcrProvider {
  readonly id: string;
  recognize(input: OcrInput, options?: OcrOptions): Promise<string[]>;
}

const DEFAULT_LANGUAGES = ["heb", "eng"] as const;
const DEFAULT_OCR_PATH = "/receipts/ocr";

type ServerOcrResponse = {
  ok?: boolean;
  lines?: string[];
  error?: string;
};

/**
 * Server-backed OCR provider.
 *
 * Posts the picked image as multipart/form-data to `${API_BASE_URL}{path}` and
 * expects a JSON response: `{ ok: true, lines: string[] }`.
 *
 * The endpoint is not part of this app — wire your backend to run Tesseract /
 * Vision / ML Kit and return the OCR'd lines. If the server returns 404 the
 * provider throws `ReceiptOcrError("unavailable", ...)` and the UI falls back
 * to manual entry.
 */
export function createServerOcrProvider(config?: {
  baseUrl?: string;
  path?: string;
}): OcrProvider {
  const baseUrl = config?.baseUrl ?? API_BASE_URL;
  const path = config?.path ?? DEFAULT_OCR_PATH;

  return {
    id: "server",
    async recognize(input, options) {
      const languages = options?.languages ?? DEFAULT_LANGUAGES;
      const onProgress = options?.onProgress;

      onProgress?.({
        stage: "upload",
        progress: 0,
        message: "Uploading image to OCR service...",
      });

      const form = new FormData();
      form.append("file", {
        uri: input.uri,
        name: input.fileName ?? guessFileName(input),
        type: input.mimeType ?? guessMimeType(input),
      } as unknown as Blob);
      form.append("languages", languages.join("+"));

      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          body: form,
          signal: options?.signal,
        });
      } catch (e) {
        if (isAbortError(e)) {
          throw new ReceiptOcrError("cancelled", "OCR cancelled");
        }
        throw new ReceiptOcrError(
          "network",
          `Could not reach OCR service: ${describeError(e)}`,
        );
      }

      if (response.status === 404) {
        throw new ReceiptOcrError(
          "unavailable",
          "OCR endpoint not configured on the server. You can still add items manually.",
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ReceiptOcrError("unauthorized", "OCR request unauthorized");
      }
      if (!response.ok) {
        const text = await safeText(response);
        throw new ReceiptOcrError(
          "unknown",
          `OCR service failed (${response.status}): ${text || "no body"}`,
        );
      }

      onProgress?.({
        stage: "parsing",
        progress: 0.9,
        message: "Parsing OCR response...",
      });

      const data = (await response.json()) as ServerOcrResponse;
      if (data.ok === false) {
        throw new ReceiptOcrError("unknown", data.error || "OCR failed");
      }
      const lines = Array.isArray(data.lines) ? data.lines : [];

      onProgress?.({ stage: "done", progress: 1, message: "Done" });
      return lines;
    },
  };
}

function guessFileName(input: OcrInput): string {
  if (input.fileName) return input.fileName;
  const ext = guessExtension(input);
  return `receipt.${ext}`;
}

function guessMimeType(input: OcrInput): string {
  if (input.mimeType) return input.mimeType;
  const lower = input.uri.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "image/jpeg";
}

function guessExtension(input: OcrInput): string {
  const mime = input.mimeType?.toLowerCase();
  if (mime?.startsWith("image/")) return mime.slice(6);
  if (mime === "application/pdf") return "pdf";
  return "jpg";
}

function isAbortError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name?: string }).name === "AbortError"
  );
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export const defaultOcrProvider: OcrProvider = createServerOcrProvider();

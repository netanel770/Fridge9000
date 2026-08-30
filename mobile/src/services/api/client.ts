import { API_BASE_URL } from "../config";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type SessionTransport = {
  getAccessToken: () => string | null;
  getRefreshToken: () => Promise<string | null>;
  acceptSession: (session: AuthTokenPayload) => Promise<void>;
  clearSession: () => Promise<void>;
};

export type AuthTokenPayload = {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  access_token_expires_at: string;
  refresh_token_expires_at: string;
  user: unknown;
};

type AuthOptions = { auth?: boolean; retryAuth?: boolean; headers?: HeadersInit };
type RequestOptions = RequestInit & AuthOptions;
type StatusResponse = { status: number };

let sessionTransport: SessionTransport | null = null;
let selectedHouseholdId: number | null = null;
let refreshRequest: Promise<boolean> | null = null;
const apiContextListeners = new Set<() => void>();

export function configureSessionTransport(transport: SessionTransport | null) {
  sessionTransport = transport;
}

export function setSelectedHouseholdHeader(householdId: number | null) {
  if (selectedHouseholdId === householdId) return;
  selectedHouseholdId = householdId;
  notifyApiContextChanged();
}

export function notifyApiContextChanged() {
  apiContextListeners.forEach((listener) => listener());
}

export function subscribeToApiContextChanges(listener: () => void) {
  apiContextListeners.add(listener);
  return () => { apiContextListeners.delete(listener); };
}

function requestHeaders(providedHeaders: HeadersInit | undefined, auth: boolean) {
  const headers = new Headers(providedHeaders);
  if (auth) {
    const token = sessionTransport?.getAccessToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  if (selectedHouseholdId != null) headers.set("X-Fridge-ID", String(selectedHouseholdId));
  return headers;
}

function validationErrorMessage(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.msg !== "string") return null;
  const location = Array.isArray(record.loc)
    ? record.loc.filter((part) => part !== "body").map(String).join(".")
    : "";
  return location ? `${location}: ${record.msg}` : record.msg;
}

export function normalizeApiError(value: unknown, fallback = "Request failed"): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const messages = value.map(validationErrorMessage).filter((message): message is string => Boolean(message));
    if (messages.length) return messages.join("; ");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if ("detail" in record) return normalizeApiError(record.detail, fallback);
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Fall through to the stable fallback for non-serializable responses.
    }
  }
  return fallback;
}

export async function handleJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    throw new ApiError(normalizeApiError(body, `Request failed (${response.status})`), response.status, body);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

export function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}

async function refreshAccessToken() {
  if (!sessionTransport) return false;
  if (!refreshRequest) {
    refreshRequest = (async () => {
      const refreshToken = await sessionTransport!.getRefreshToken();
      if (!refreshToken) {
        await sessionTransport!.clearSession();
        return false;
      }
      const response = await fetch(apiUrl("/auth/refresh"), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!response.ok) {
        await sessionTransport!.clearSession();
        return false;
      }
      const session = await handleJsonResponse<AuthTokenPayload>(response);
      await sessionTransport!.acceptSession(session);
      return true;
    })().catch(async () => {
      await sessionTransport?.clearSession();
      return false;
    }).finally(() => { refreshRequest = null; });
  }
  return refreshRequest;
}

export async function requestWithAuthRetry<T extends StatusResponse>(
  execute: (headers: Headers) => Promise<T>,
  options: AuthOptions = {},
) {
  const { auth = true, retryAuth = true, headers: providedHeaders } = options;
  let response = await execute(requestHeaders(providedHeaders, auth));
  if (auth && retryAuth && response.status === 401 && await refreshAccessToken()) {
    response = await execute(requestHeaders(providedHeaders, auth));
    if (response.status === 401) await sessionTransport?.clearSession();
  }
  return response;
}

export async function requestJsonResponse<T>(path: string, options: RequestOptions = {}) {
  const { auth = true, retryAuth = true, headers: providedHeaders, ...init } = options;
  const response = await requestWithAuthRetry(
    (headers) => fetch(apiUrl(path), { ...init, headers }),
    { auth, retryAuth, headers: providedHeaders },
  );
  const data = await handleJsonResponse<T>(response);
  return { data, response };
}

export function requestApiResponse(path: string, options: RequestOptions = {}) {
  const { auth = true, retryAuth = true, headers: providedHeaders, ...init } = options;
  return requestWithAuthRetry(
    (headers) => fetch(apiUrl(path), { ...init, headers }),
    { auth, retryAuth, headers: providedHeaders },
  );
}

export async function requestJson<T>(path: string, init?: RequestOptions): Promise<T> {
  return (await requestJsonResponse<T>(path, init)).data;
}

export const JSON_HEADERS = { "Content-Type": "application/json" } as const;

import {
  configureSessionTransport,
  normalizeApiError,
  requestJson,
  setSelectedHouseholdHeader,
  type AuthTokenPayload,
} from "../../src/services/api/client";

const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();

function response(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: jest.fn().mockResolvedValue(text),
  } as unknown as Response;
}

function session(accessToken = "new-access"): AuthTokenPayload {
  return {
    access_token: accessToken,
    refresh_token: "new-refresh",
    token_type: "bearer",
    access_token_expires_at: "2030-01-01T00:00:00Z",
    refresh_token_expires_at: "2030-02-01T00:00:00Z",
    user: { id: 1 },
  };
}

function header(call: number, name: string) {
  const headers = fetchMock.mock.calls[call][1]?.headers as Headers;
  return headers.get(name);
}

describe("central API client", () => {
  let accessToken: string | null;
  let getRefreshToken: jest.Mock<Promise<string | null>, []>;
  let acceptSession: jest.Mock<Promise<void>, [AuthTokenPayload]>;
  let clearSession: jest.Mock<Promise<void>, []>;

  beforeAll(() => { global.fetch = fetchMock as unknown as typeof fetch; });

  beforeEach(() => {
    fetchMock.mockReset();
    accessToken = null;
    getRefreshToken = jest.fn().mockResolvedValue("refresh-token");
    acceptSession = jest.fn(async (next) => { accessToken = next.access_token; });
    clearSession = jest.fn(async () => { accessToken = null; });
    configureSessionTransport({
      getAccessToken: () => accessToken,
      getRefreshToken,
      acceptSession,
      clearSession,
    });
    setSelectedHouseholdHeader(null);
  });

  afterAll(() => configureSessionTransport(null));

  test("parses JSON and omits auth headers for an unauthenticated session", async () => {
    fetchMock.mockResolvedValue(response(200, { ok: true }));
    await expect(requestJson("/health")).resolves.toEqual({ ok: true });
    expect(header(0, "Authorization")).toBeNull();
    expect(header(0, "X-Fridge-ID")).toBeNull();
  });

  test("injects access and selected-household headers and follows household changes", async () => {
    accessToken = "access-token";
    fetchMock.mockResolvedValue(response(200, { ok: true }));
    setSelectedHouseholdHeader(7);
    await requestJson("/inventory");
    setSelectedHouseholdHeader(12);
    await requestJson("/inventory");
    expect(header(0, "Authorization")).toBe("Bearer access-token");
    expect(header(0, "X-Fridge-ID")).toBe("7");
    expect(header(1, "X-Fridge-ID")).toBe("12");
  });

  test("returns undefined for an empty successful response", async () => {
    fetchMock.mockResolvedValue(response(204));
    await expect(requestJson("/empty")).resolves.toBeUndefined();
  });

  test("normalizes FastAPI validation details and ordinary API errors", async () => {
    expect(normalizeApiError({ detail: [
      { loc: ["body", "email"], msg: "invalid email" },
      { loc: ["body", "password"], msg: "too short" },
    ] })).toBe("email: invalid email; password: too short");
    fetchMock.mockResolvedValue(response(409, { detail: "Already exists" }));
    await expect(requestJson("/conflict")).rejects.toMatchObject({
      name: "ApiError", status: 409, message: "Already exists",
    });
  });

  test("refreshes after 401 and retries with the replacement access token", async () => {
    accessToken = "expired-access";
    fetchMock
      .mockResolvedValueOnce(response(401, { detail: "expired" }))
      .mockResolvedValueOnce(response(200, session()))
      .mockResolvedValueOnce(response(200, { value: 42 }));
    await expect(requestJson("/protected")).resolves.toEqual({ value: 42 });
    expect(fetchMock.mock.calls[1][0]).toBe("http://api.test/auth/refresh");
    expect(header(0, "Authorization")).toBe("Bearer expired-access");
    expect(header(2, "Authorization")).toBe("Bearer new-access");
    expect(acceptSession).toHaveBeenCalledWith(session());
    expect(clearSession).not.toHaveBeenCalled();
  });

  test("clears the session when refresh fails", async () => {
    accessToken = "expired-access";
    fetchMock.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(401));
    await expect(requestJson("/protected")).rejects.toMatchObject({ status: 401 });
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("clears the session when the retried request is also unauthorized", async () => {
    accessToken = "expired-access";
    fetchMock
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, session()))
      .mockResolvedValueOnce(response(401));
    await expect(requestJson("/protected")).rejects.toMatchObject({ status: 401 });
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  test("uses one refresh for concurrent 401 responses and retries every waiter", async () => {
    accessToken = "expired-access";
    let releaseRefresh!: (value: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => { releaseRefresh = resolve; });
    let protectedCalls = 0;
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/auth/refresh")) return pendingRefresh;
      protectedCalls += 1;
      return protectedCalls <= 2 ? response(401) : response(200, { call: protectedCalls });
    });
    const first = requestJson<{ call: number }>("/first");
    const second = requestJson<{ call: number }>("/second");
    await Promise.resolve();
    await Promise.resolve();
    releaseRefresh(response(200, session("shared-access")));
    await expect(Promise.all([first, second])).resolves.toEqual([{ call: 3 }, { call: 4 }]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/auth/refresh"))).toHaveLength(1);
    expect(acceptSession).toHaveBeenCalledTimes(1);
    expect(header(3, "Authorization")).toBe("Bearer shared-access");
    expect(header(4, "Authorization")).toBe("Bearer shared-access");
  });

  test("auth false neither injects credentials nor refreshes", async () => {
    accessToken = "access-token";
    setSelectedHouseholdHeader(5);
    fetchMock.mockResolvedValue(response(401));
    await expect(requestJson("/auth/login", { auth: false })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(header(0, "Authorization")).toBeNull();
    expect(header(0, "X-Fridge-ID")).toBe("5");
    expect(getRefreshToken).not.toHaveBeenCalled();
  });

  test("retryAuth false leaves a 401 untouched", async () => {
    accessToken = "access-token";
    fetchMock.mockResolvedValue(response(401));
    await expect(requestJson("/protected", { retryAuth: false })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRefreshToken).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });
});

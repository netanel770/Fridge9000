import { checkDetectionFreshness } from "../../src/services/api/scans";
import { requestJson } from "../../src/services/api/client";

jest.mock("../../src/services/api/client", () => ({
  requestJson: jest.fn(),
  requestJsonResponse: jest.fn(),
  apiUrl: jest.fn(),
  normalizeApiError: jest.fn(),
  ApiError: class ApiError extends Error {},
  JSON_HEADERS: { "Content-Type": "application/json" },
}));

jest.mock("../../src/services/api/upload", () => ({ appendUploadFile: jest.fn() }));

const mockedRequestJson = requestJson as jest.MockedFunction<typeof requestJson>;

test("posts a freshness request for the exact scan detection", async () => {
  mockedRequestJson.mockResolvedValue({ ok: true });

  await checkDetectionFreshness(42, 11);

  expect(mockedRequestJson).toHaveBeenCalledWith(
    "/scans/42/detections/11/freshness",
    { method: "POST" },
  );
});

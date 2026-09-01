import { Platform } from "react-native";

import { loadProtectedImage } from "../../src/services/api/protectedImages";
import { requestApiResponse } from "../../src/services/api/client";

jest.mock("../../src/services/api/client", () => {
  const actual = jest.requireActual("../../src/services/api/client");
  return { ...actual, requestApiResponse: jest.fn() };
});

const mockedRequest = requestApiResponse as jest.MockedFunction<typeof requestApiResponse>;

describe("protected image loading", () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    Object.defineProperty(Platform, "OS", { configurable: true, value: "web" });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: jest.fn(() => "blob:fresh-outline"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: jest.fn(),
    });
  });

  afterEach(() => {
    Object.defineProperty(Platform, "OS", { configurable: true, value: originalPlatform });
  });

  test("bypasses browser caching for mutable authenticated outlines", async () => {
    const blob = {} as Blob;
    mockedRequest.mockResolvedValue({
      ok: true,
      status: 200,
      blob: jest.fn().mockResolvedValue(blob),
    } as unknown as Response);

    const loaded = await loadProtectedImage(
      "http://api.test/items/7/representative-image?revision=server-revision",
    );

    expect(mockedRequest).toHaveBeenCalledWith(
      "/items/7/representative-image?revision=server-revision",
      { cache: "no-store" },
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(loaded.uri).toBe("blob:fresh-outline");
    await loaded.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fresh-outline");
  });
});

import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useAuthenticatedImage } from "../../src/components/useAuthenticatedImage";
import {
  isProtectedApiImageUri,
  loadProtectedImage,
  subscribeToApiContextChanges,
} from "../../src/services/api";

jest.mock("../../src/services/api", () => ({
  isProtectedApiImageUri: jest.fn(),
  loadProtectedImage: jest.fn(),
  subscribeToApiContextChanges: jest.fn(),
}));

const mockedIsProtected = jest.mocked(isProtectedApiImageUri);
const mockedLoad = jest.mocked(loadProtectedImage);
const mockedSubscribe = jest.mocked(subscribeToApiContextChanges);

describe("useAuthenticatedImage", () => {
  let contextChanged: () => void;

  beforeEach(() => {
    mockedSubscribe.mockImplementation((listener) => {
      contextChanged = listener;
      return jest.fn();
    });
  });

  test("passes public images through without fetching", async () => {
    mockedIsProtected.mockReturnValue(false);
    const { result } = await renderHook(() => useAuthenticatedImage("https://cdn.test/icon.png"));
    expect(result.current.resolvedUri).toBe("https://cdn.test/icon.png");
    expect(result.current.protected).toBe(false);
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  test("loads protected media, reports image load, and releases the cached object", async () => {
    mockedIsProtected.mockReturnValue(true);
    const release = jest.fn().mockResolvedValue(undefined);
    mockedLoad.mockResolvedValue({ uri: "blob:protected", release });
    const { result, unmount } = await renderHook(() => useAuthenticatedImage("http://api.test/scans/1/image"));
    expect(result.current.status).toBe("LOADING");
    await waitFor(() => expect(result.current.resolvedUri).toBe("blob:protected"));
    await act(() => result.current.onLoad());
    expect(result.current.status).toBe("LOADED");
    await unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("surfaces load failures and retries after API context changes", async () => {
    mockedIsProtected.mockReturnValue(true);
    mockedLoad
      .mockRejectedValueOnce(new Error("unauthorized"))
      .mockResolvedValueOnce({ uri: "blob:retried", release: jest.fn().mockResolvedValue(undefined) });
    const { result } = await renderHook(() => useAuthenticatedImage("http://api.test/scans/1/image"));
    await waitFor(() => expect(result.current.status).toBe("ERROR"));
    await act(() => contextChanged());
    await waitFor(() => expect(result.current.resolvedUri).toBe("blob:retried"));
    expect(mockedLoad).toHaveBeenCalledTimes(2);
  });

  test("manual image errors clear the resolved URI", async () => {
    mockedIsProtected.mockReturnValue(true);
    mockedLoad.mockResolvedValue({ uri: "blob:protected", release: jest.fn().mockResolvedValue(undefined) });
    const { result } = await renderHook(() => useAuthenticatedImage("http://api.test/image"));
    await waitFor(() => expect(result.current.resolvedUri).toBe("blob:protected"));
    await act(() => result.current.onError());
    expect(result.current.status).toBe("ERROR");
    expect(result.current.resolvedUri).toBeNull();
  });
});

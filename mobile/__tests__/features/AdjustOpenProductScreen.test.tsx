import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import AdjustOpenProductScreen from "../../app/adjust-open-product";
import * as ImagePicker from "expo-image-picker";
import {
  getInventoryBatches,
  uploadProductRepresentativeImage,
} from "../../src/services/api";
import { confirmAction, showMessage } from "../../src/utils/confirm";

let mockIsSystemAdmin = false;
let mockImageStatus: "LOADING" | "LOADED" | "ERROR" = "LOADED";
const mockAuthenticatedImageUris: string[] = [];

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ itemId: "7", itemName: "Milk" }),
}));

jest.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock("../../src/services/api", () => ({
  getInventoryBatches: jest.fn(),
  updateInventoryBatchRemaining: jest.fn(),
  uploadProductRepresentativeImage: jest.fn(),
}));

jest.mock("../../src/features/auth/AuthContext", () => ({
  useAuth: () => ({ user: { is_system_admin: mockIsSystemAdmin } }),
}));

jest.mock("../../src/components/useAuthenticatedImage", () => ({
  useAuthenticatedImage: (uri: string) => {
    mockAuthenticatedImageUris.push(uri);
    return {
      resolvedUri: mockImageStatus === "LOADED" ? "blob:outline" : null,
      status: mockImageStatus,
      retry: jest.fn(),
      onLoad: jest.fn(),
      onError: jest.fn(),
      protected: true,
    };
  },
}));

jest.mock("../../src/utils/confirm", () => ({
  confirmAction: jest.fn(),
  showMessage: jest.fn(),
}));

const mockedPicker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const mockedGetBatches = getInventoryBatches as jest.MockedFunction<typeof getInventoryBatches>;
const mockedUpload = uploadProductRepresentativeImage as jest.MockedFunction<
  typeof uploadProductRepresentativeImage
>;
const mockedConfirm = confirmAction as jest.MockedFunction<typeof confirmAction>;
const mockedShowMessage = showMessage as jest.MockedFunction<typeof showMessage>;

async function renderScreen() {
  const view = await render(<AdjustOpenProductScreen />);
  await waitFor(() => expect(view.getByText("Milk")).toBeTruthy());
  return view;
}

describe("AdjustOpenProductScreen representative image administration", () => {
  beforeEach(() => {
    mockIsSystemAdmin = false;
    mockImageStatus = "LOADED";
    mockAuthenticatedImageUris.length = 0;
    mockedGetBatches.mockResolvedValue([{
      id: 11,
      item_id: 7,
      quantity: 1,
      expiry_date: "2026-10-01",
      open_unit_remaining_percent: 60,
    } as never]);
    mockedPicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true } as never);
    mockedPicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///replacement.jpg" }],
    } as never);
    mockedConfirm.mockResolvedValue(true);
    mockedShowMessage.mockResolvedValue();
    mockedUpload.mockResolvedValue({ ok: true, quality_score: 0.82 });
    jest.spyOn(Alert, "alert").mockImplementation(jest.fn());
  });

  test("does not expose replacement controls to a non-admin", async () => {
    const view = await renderScreen();
    expect(view.queryByText("Improve segmentation")).toBeNull();
    expect(view.queryByText("Add product image")).toBeNull();
  });

  test("shows Improve segmentation to an admin when an outline exists", async () => {
    mockIsSystemAdmin = true;
    const view = await renderScreen();
    expect(view.getByText("Improve segmentation")).toBeTruthy();
    expect(view.queryByText("Add product image")).toBeNull();
  });

  test("shows Add product image to an admin when no outline exists", async () => {
    mockIsSystemAdmin = true;
    mockImageStatus = "ERROR";
    const view = await renderScreen();
    expect(view.getByText("Add product image")).toBeTruthy();
    expect(view.queryByText("Improve segmentation")).toBeNull();
  });

  test("confirms replacement, reports quality, and refreshes the cached image URI", async () => {
    mockIsSystemAdmin = true;
    const view = await renderScreen();
    await fireEvent.press(view.getByText("Improve segmentation"));

    await waitFor(() => expect(mockedUpload).toHaveBeenCalledWith(7, "file:///replacement.jpg"));
    await waitFor(() => expect(mockAuthenticatedImageUris.some((uri) => uri.endsWith("?v=1"))).toBe(true));
    expect(mockedConfirm).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("shared product outline for everyone"),
    }));
    expect(mockedShowMessage).toHaveBeenCalledWith(
      "Segmentation improved",
      "New segmentation created. Quality score: 82%",
    );
  });

  test("keeps the current outline when replacement fails", async () => {
    mockIsSystemAdmin = true;
    mockedUpload.mockRejectedValue(new Error("SAM failed"));
    const view = await renderScreen();
    await fireEvent.press(view.getByText("Improve segmentation"));

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Image processing failed", "SAM failed"));
    expect(mockAuthenticatedImageUris.some((uri) => uri.endsWith("?v=1"))).toBe(false);
    expect(view.getByText("Improve segmentation")).toBeTruthy();
  });

  test("blocks duplicate submissions while segmentation is processing", async () => {
    mockIsSystemAdmin = true;
    let finishUpload!: (value: { ok: boolean; quality_score: number }) => void;
    mockedUpload.mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));
    const view = await renderScreen();
    const improveButton = view.getByText("Improve segmentation");
    await act(async () => {
      const submission = fireEvent.press(improveButton);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockedUpload).toHaveBeenCalledTimes(1);
      const duplicate = fireEvent.press(improveButton);
      expect(mockedUpload).toHaveBeenCalledTimes(1);
      finishUpload({ ok: true, quality_score: 0.75 });
      await Promise.all([submission, duplicate]);
    });
    await waitFor(() => expect(mockedShowMessage).toHaveBeenCalled());
  });
});

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { BackHandler } from "react-native";

import ReviewScreen from "../../app/review";
import {
  checkDetectionFreshness,
  getAllInventory,
  getInventoryBatches,
  getScanDetections,
  submitReview,
} from "../../src/services/api";

let prevented = false;
let stackOptions: Record<string, unknown> = {};
let hardwareBackHandler: (() => boolean) | undefined;

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({ scanId: "42", mode: "Added", source: "scan" }),
  Stack: {
    Screen: ({ options }: { options: Record<string, unknown> }) => {
      stackOptions = options;
      return null;
    },
  },
}));

jest.mock("@react-navigation/native", () => ({
  usePreventRemove: (value: boolean) => { prevented = value; },
}));

jest.mock("../../src/services/api", () => ({
  checkDetectionFreshness: jest.fn(),
  getAllInventory: jest.fn(),
  getInventoryBatches: jest.fn(),
  getScanDetections: jest.fn(),
  submitReview: jest.fn(),
}));

jest.mock("../../src/features/auth/AuthContext", () => ({
  useAuth: () => ({ user: { is_system_admin: false } }),
}));

jest.mock("../../src/components/ProductLabelInput", () => {
  const { TextInput } = jest.requireActual("react-native");
  return {
    ProductLabelInput: ({ value, onChangeText, disabled, accessibilityLabel }: {
      value: string;
      onChangeText: (value: string) => void;
      disabled: boolean;
      accessibilityLabel: string;
    }) => <TextInput
      value={value}
      onChangeText={onChangeText}
      editable={!disabled}
      accessibilityLabel={accessibilityLabel}
    />,
  };
});

jest.mock("../../src/components/useAuthenticatedImage", () => ({
  useAuthenticatedImage: () => ({
    resolvedUri: "blob:boxed-image",
    status: "LOADED",
    retry: jest.fn(),
    onLoad: jest.fn(),
    onError: jest.fn(),
  }),
}));

const mockedCheckFreshness = checkDetectionFreshness as jest.MockedFunction<typeof checkDetectionFreshness>;
const mockedGetInventory = getAllInventory as jest.MockedFunction<typeof getAllInventory>;
const mockedGetBatches = getInventoryBatches as jest.MockedFunction<typeof getInventoryBatches>;
const mockedGetDetections = getScanDetections as jest.MockedFunction<typeof getScanDetections>;
const mockedSubmitReview = submitReview as jest.MockedFunction<typeof submitReview>;

const detections = [
  { id: 11, label: "Apple", confidence: 0.91, x1: 1, y1: 2, x2: 20, y2: 30, freshness_supported: true },
  { id: 12, label: "Milk", confidence: 0.88, x1: 2, y1: 3, x2: 21, y2: 31, freshness_supported: false },
  { id: 13, label: "Apple", confidence: 0.87, x1: 3, y1: 4, x2: 22, y2: 32, freshness_supported: true },
];

function response(predictedClass: "Fresh Apples" | "Rotten Apples", confidence: number) {
  return {
    ok: true,
    detection_id: 11,
    classification: {
      class_id: predictedClass === "Fresh Apples" ? 0 : 1,
      predicted_class: predictedClass,
      item: "Apples",
      condition: predictedClass.startsWith("Fresh") ? "Fresh" as const : "Rotten" as const,
      confidence,
      is_rotten: predictedClass.startsWith("Rotten"),
    },
  };
}

async function renderScreen() {
  const view = await render(<ReviewScreen />);
  await waitFor(() => expect(view.getAllByText("Check Freshness")).toHaveLength(2));
  return view;
}

describe("Review freshness checks", () => {
  beforeEach(() => {
    prevented = false;
    stackOptions = {};
    hardwareBackHandler = undefined;
    mockedGetDetections.mockResolvedValue(detections);
    mockedGetBatches.mockResolvedValue([]);
    mockedGetInventory.mockResolvedValue([]);
    mockedSubmitReview.mockResolvedValue({ ok: true });
    jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, handler) => {
      hardwareBackHandler = () => Boolean(handler());
      return { remove: jest.fn() };
    });
  });

  test("shows controls only for backend-supported detections", async () => {
    const view = await renderScreen();
    expect(view.getAllByText("Check Freshness")).toHaveLength(2);
    expect(view.getByText("Milk")).toBeTruthy();
    expect(view.queryByText("Freshness unavailable")).toBeNull();
  });

  test("locks the full screen and navigation while preserving the selected image", async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    mockedCheckFreshness.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = await renderScreen();

    fireEvent.press(view.getAllByText("Check Freshness")[0]);
    await waitFor(() => expect(view.getByLabelText("Checking freshness for Apple")).toBeTruthy());

    expect(mockedCheckFreshness).toHaveBeenCalledWith(42, 11);
    expect(view.getAllByTestId(/boxed-detection-image-/)).toHaveLength(3);
    expect(view.getAllByLabelText("Final product label for Apple")[0].props.editable).toBe(false);
    expect(view.getAllByDisplayValue(/^\d{4}-\d{2}-\d{2}$/)[0].props.editable).toBe(false);
    expect(view.getAllByLabelText("Include Apple")[0].props.disabled).toBe(true);
    expect(view.getByLabelText("Submit Review").props.accessibilityState.disabled).toBe(true);
    expect(view.getAllByText("Check Freshness")).toHaveLength(1);
    fireEvent.press(view.getAllByText("Check Freshness")[0]);
    expect(mockedCheckFreshness).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
    expect(stackOptions).toEqual(expect.objectContaining({ gestureEnabled: false, headerBackVisible: false }));
    expect(hardwareBackHandler?.()).toBe(true);

    await act(async () => finish(response("Fresh Apples", 0.94)));
    await waitFor(() => expect(view.getByText("Fresh Apples · 94%")).toBeTruthy());
    expect(prevented).toBe(false);
  });

  test.each([
    ["Fresh Apples" as const, 0.94, "Fresh Apples · 94%"],
    ["Rotten Apples" as const, 0.96, "Rotten Apples · 96%"],
  ])("shows the returned %s result and confidence without mutating review values", async (classification, confidence, pill) => {
    mockedCheckFreshness.mockResolvedValue(response(classification, confidence));
    const view = await renderScreen();
    fireEvent.press(view.getAllByText("Check Freshness")[0]);
    await waitFor(() => expect(view.getByText(pill)).toBeTruthy());
    expect(view.getAllByLabelText("Final product label for Apple")[0].props.value).toBe("Apple");
    expect(view.getAllByLabelText("Include Apple")[0].props.value).toBe(true);
    expect(view.getByLabelText("Submit Review").props.accessibilityState.disabled).toBe(false);
  });

  test("unlocks after failure and allows retry", async () => {
    mockedCheckFreshness
      .mockRejectedValueOnce(new Error("Classifier unavailable"))
      .mockResolvedValueOnce(response("Fresh Apples", 0.9));
    const view = await renderScreen();
    fireEvent.press(view.getAllByText("Check Freshness")[0]);
    await waitFor(() => expect(view.getByText("Classifier unavailable")).toBeTruthy());
    expect(prevented).toBe(false);
    fireEvent.press(view.getByText("Retry Freshness"));
    await waitFor(() => expect(view.getByText("Fresh Apples · 90%")).toBeTruthy());
    expect(mockedCheckFreshness).toHaveBeenCalledTimes(2);
  });

  test("treats a malformed backend response as a local retryable failure", async () => {
    mockedCheckFreshness.mockResolvedValue({ ok: true, detection_id: 11 } as never);
    const view = await renderScreen();
    fireEvent.press(view.getAllByText("Check Freshness")[0]);
    await waitFor(() => expect(view.getByText("The freshness service returned an invalid result.")).toBeTruthy());
    expect(view.getByText("Retry Freshness")).toBeTruthy();
    expect(view.getByLabelText("Submit Review").props.accessibilityState.disabled).toBe(false);
    expect(view.getAllByTestId(/boxed-detection-image-/)).toHaveLength(3);
  });

  test("allows normal edits and Review submission after freshness completes", async () => {
    mockedCheckFreshness.mockResolvedValue(response("Fresh Apples", 0.93));
    const view = await renderScreen();
    fireEvent.press(view.getAllByText("Check Freshness")[0]);
    await waitFor(() => expect(view.getByText("Fresh Apples · 93%")).toBeTruthy());

    await act(async () => {
      fireEvent(view.getAllByLabelText("Include Apple")[0], "valueChange", false);
    });
    await waitFor(() => expect(view.getAllByLabelText("Include Apple")[0].props.value).toBe(false));
    await act(async () => {
      fireEvent.changeText(view.getAllByLabelText("Final product label for Apple")[0], "Green Apple");
    });
    await waitFor(() => expect(view.getAllByLabelText("Final product label for Apple")[0].props.value).toBe("Green Apple"));
    fireEvent.press(view.getByLabelText("Submit Review"));

    await waitFor(() => expect(mockedSubmitReview).toHaveBeenCalledTimes(1));
    expect(mockedSubmitReview.mock.calls[0][1][0]).toEqual(expect.objectContaining({
      final_label: "Green Apple",
      included: false,
    }));
  });

  test("does not update state after unmount while inference is pending", async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    mockedCheckFreshness.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = await renderScreen();
    fireEvent.press(view.getAllByText("Check Freshness")[0]);
    await waitFor(() => expect(mockedCheckFreshness).toHaveBeenCalledTimes(1));
    await view.unmount();
    await act(async () => finish(response("Fresh Apples", 0.91)));
    expect(mockedSubmitReview).not.toHaveBeenCalled();
  });

  test("keeps successful results independent for multiple detections", async () => {
    mockedCheckFreshness
      .mockResolvedValueOnce(response("Fresh Apples", 0.95))
      .mockResolvedValueOnce({
        ...response("Rotten Apples", 0.92),
        detection_id: 13,
      });
    const view = await renderScreen();
    fireEvent.press(view.getAllByText("Check Freshness")[0]);
    await waitFor(() => expect(view.getByText("Fresh Apples · 95%")).toBeTruthy());
    fireEvent.press(view.getByText("Check Freshness"));
    await waitFor(() => expect(view.getByText("Rotten Apples · 92%")).toBeTruthy());
    expect(view.getByText("Fresh Apples · 95%")).toBeTruthy();
    expect(mockedCheckFreshness.mock.calls).toEqual([[42, 11], [42, 13]]);
  });
});

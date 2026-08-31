import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useModeration } from "../../src/features/teach-fridge/hooks/useModeration";
import {
  getAnnotationSubmission,
  getAnnotationSubmissions,
  moderateAnnotationSubmission,
} from "../../src/services/api";

jest.mock("../../src/services/api", () => ({
  getAnnotationSubmission: jest.fn(),
  getAnnotationSubmissions: jest.fn(),
  moderateAnnotationSubmission: jest.fn(),
}));

const pending = {
  id: 10,
  scan_id: 3,
  status: "pending" as const,
  image_width: 100,
  image_height: 100,
  created_at: "2026-01-02T03:04:05Z",
};

describe("useModeration", () => {
  beforeEach(() => {
    jest.mocked(getAnnotationSubmissions).mockResolvedValue([pending]);
    jest.mocked(getAnnotationSubmission).mockResolvedValue({ submission: pending, annotations: [] });
    jest.mocked(moderateAnnotationSubmission).mockResolvedValue({ ok: true } as never);
  });

  test.each(["approved", "rejected"] as const)("invalidates contribution history after an item is %s", async (status) => {
    const refreshContributions = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderHook(() => useModeration(true, refreshContributions));
    await waitFor(() => expect(result.current.submissions).toHaveLength(1));

    await act(async () => {
      await result.current.moderateSubmission(10, status);
    });

    expect(moderateAnnotationSubmission).toHaveBeenCalledWith(10, status);
    expect(refreshContributions).toHaveBeenCalledTimes(1);
    expect(result.current.submissions).toEqual([]);
    expect(result.current.message).toContain(status);
  });
});

import type { FreshnessAnalysisResponse } from "../../types/api";
import { requestJson } from "./client";

export function analyzeFreshness(imageUri: string): Promise<FreshnessAnalysisResponse> {
  const formData = new FormData();
  formData.append("file", {
    uri: imageUri,
    name: "freshness-analysis.jpg",
    type: "image/jpeg",
  } as any);
  return requestJson<FreshnessAnalysisResponse>("/freshness/analyze", {
    method: "POST",
    body: formData,
  });
}

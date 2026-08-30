import type { FreshnessAnalysisResponse } from "../../types/api";
import { requestJson } from "./client";
import { appendUploadFile } from "./upload";

export async function analyzeFreshness(
  imageUri: string,
): Promise<FreshnessAnalysisResponse> {
  const formData = new FormData();

  await appendUploadFile(
    formData,
    "file",
    imageUri,
    "freshness-analysis.jpg",
    "image/jpeg",
  );

  return requestJson<FreshnessAnalysisResponse>("/freshness/analyze", {
    method: "POST",
    body: formData,
  });
}

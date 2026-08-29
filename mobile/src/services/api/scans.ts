import type { DetectionItem, LatestScan, RecentScan, ReviewItem, UploadScanResponse } from "../../types/api";
import { ApiError, JSON_HEADERS, apiUrl, normalizeApiError, requestJson, requestJsonResponse } from "./client";

export async function getLatestScan(): Promise<LatestScan | null> {
  const data = await requestJson<any>("/scans/latest");
  if (!data || !data.id) return null;
  return data as LatestScan;
}

export function getScanDetections(scanId: number): Promise<DetectionItem[]> {
  return requestJson<DetectionItem[]>(`/scans/${scanId}/detections`);
}

export async function submitReview(
  scanId: number,
  items: ReviewItem[],
  mode: "Added" | "Removed",
  source: "scan" | "receipt" = "scan",
) {
  const { data, response } = await requestJsonResponse<any>(`/scans/${scanId}/review`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ mode, items, source }),
  });
  if (data.ok === false) {
    throw new ApiError(normalizeApiError(data, "Review submit failed"), response.status, data);
  }
  return data;
}

export function uploadScanImage(imageUri: string): Promise<UploadScanResponse> {
  const formData = new FormData();
  formData.append("file", {
    uri: imageUri,
    name: "fridge-scan.jpg",
    type: "image/jpeg",
  } as any);
  return requestJson<UploadScanResponse>("/door/closed/upload", {
    method: "POST",
    body: formData,
  });
}

export function getRecentScans(limit = 10): Promise<RecentScan[]> {
  return requestJson<RecentScan[]>(`/scans/recent?limit=${limit}`);
}

export function getScan(scanId: number): Promise<RecentScan> {
  return requestJson<RecentScan>(`/scans/${encodeURIComponent(scanId)}`);
}

export function getScanImageUrl(scanId: number) {
  return apiUrl(`/scans/${scanId}/image`);
}

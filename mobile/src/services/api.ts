import { API_BASE_URL } from "./config";
import type {
  InventoryItem,
  InventoryBatchItem,
  AlertItem,
  EventItem,
  LatestScan,
  RecentScan,
  CreateAnnotationSubmissionResponse,
  AnnotationItem,
  AIProgressResponse,
  LifecycleJob,
  AnnotationStats,
  AnnotationStatus,
  AnnotationSubmission,
  AnnotationSubmissionDetail,
  DetectionItem,
  ReviewItem,
  UploadScanResponse,
  FreshnessAnalysisResponse,
} from "../types/api";

async function handleJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      throw new Error(data.detail || data.error || "Request failed");
    } catch (error) {
      if (error instanceof Error && error.name === "Error") {
        throw error;
      }
      throw new Error(text || "Request failed");
    }
  }
  return response.json();
}

export async function getInventory(signal?: AbortSignal): Promise<InventoryItem[]> {
  const res = await fetch(`${API_BASE_URL}/inventory`, { signal });
  return handleJsonResponse<InventoryItem[]>(res);
}

export async function getInventoryBatches(signal?: AbortSignal): Promise<InventoryBatchItem[]> {
  const res = await fetch(`${API_BASE_URL}/inventory/batches`, { signal });
  return handleJsonResponse<InventoryBatchItem[]>(res);
}

export async function getAllInventory(): Promise<InventoryItem[]> {
  const res = await fetch(`${API_BASE_URL}/inventory/all`);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.detail || data.error || "Failed to load all inventory");
  }

  return data;
}

export async function searchInventoryItems(query: string) {
  const inventory = await getInventory();

  return inventory.filter((item) =>
    item.name.toLowerCase().includes(query.toLowerCase())
  );
}

export async function manualInventoryUpdate(
  itemName: string,
  action: "Added" | "Removed",
  quantity: number,
  expiryDate: string,
  expirySource: "manual" | "estimated" = "manual",
) {
  const withoutExpiry = action === "Removed" && expiryDate === "__NO_EXPIRY__";
  const res = await fetch(`${API_BASE_URL}/inventory/manual`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      item_name: itemName,
      action,
      quantity,
      expiry_date: withoutExpiry ? null : expiryDate,
      expiry_source: expirySource,
      without_expiry: withoutExpiry,
    }),
  });

  const data = await res.json();

  if (!res.ok || data.ok === false) {
    throw new Error(data.detail || data.error || "Manual inventory update failed");
  }

  return data;
}
export async function getAlerts(signal?: AbortSignal): Promise<AlertItem[]> {
  const res = await fetch(`${API_BASE_URL}/alerts`, { signal });
  return handleJsonResponse<AlertItem[]>(res);
}

export async function getEvents(limit = 20): Promise<EventItem[]> {
  const res = await fetch(`${API_BASE_URL}/events?limit=${limit}`);
  return handleJsonResponse<EventItem[]>(res);
}

export async function getLatestScan(): Promise<LatestScan | null> {
  const res = await fetch(`${API_BASE_URL}/scans/latest`);
  const data = await handleJsonResponse<any>(res);

  if (!data || !data.id) return null;
  return data as LatestScan;
}

export async function getScanDetections(scanId: number): Promise<DetectionItem[]> {
  const res = await fetch(`${API_BASE_URL}/scans/${scanId}/detections`);
  return handleJsonResponse<DetectionItem[]>(res);
}

export async function submitReview(
  scanId: number,
  items: ReviewItem[],
  mode: "Added" | "Removed",
  source: "scan" | "receipt" = "scan",
) {
  const res = await fetch(`${API_BASE_URL}/scans/${scanId}/review`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode,
      items,
      source,
    }),
  });

  const data = await res.json();

  if (!res.ok || data.ok === false) {
    throw new Error(data.detail || data.error || "Review submit failed");
  }

  return data;
}

export type ManualInventoryResponse = {
  ok: boolean;
  item_id?: number;
  new_quantity?: number;
  error?: string;
};

export async function addInventoryItem(
  itemName: string,
  quantity: number,
  signal?: AbortSignal,
): Promise<ManualInventoryResponse> {
  const res = await fetch(`${API_BASE_URL}/inventory/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      item_name: itemName,
      action: "Added",
      quantity,
    }),
    signal,
  });
  const data = (await res.json()) as ManualInventoryResponse;
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

export async function uploadScanImage(imageUri: string): Promise<UploadScanResponse> {
  const formData = new FormData();

  formData.append("file", {
    uri: imageUri,
    name: "fridge-scan.jpg",
    type: "image/jpeg",
  } as any);

  const res = await fetch(`${API_BASE_URL}/door/closed/upload`, {
    method: "POST",
    body: formData,
  });

  return handleJsonResponse<UploadScanResponse>(res);
}

export async function updateInventoryByImage(
  imageUri: string,
  action: "Added" | "Removed"
) {
  const formData = new FormData();

  formData.append("file", {
    uri: imageUri,
    name: "inventory-image.jpg",
    type: "image/jpeg",
  } as any);

  const res = await fetch(`${API_BASE_URL}/inventory/image/update?action=${action}`, {
    method: "POST",
    body: formData,
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.detail || data.error || "Image update failed");
  }

  return data;
}

export async function uploadReceiptPdf(file: any) {
  const formData = new FormData();

  formData.append("file", {
    uri: file.uri,
    name: file.name || "receipt.jpg",
    type: file.mimeType || "image/jpeg",
  } as any);

  const res = await fetch(`${API_BASE_URL}/receipts/upload`, {
    method: "POST",
    body: formData,
  });

  const data = await res.json();

  if (!res.ok || data.ok === false) {
    throw new Error(
      data.detail || data.error || "Receipt upload failed"
    );
  }

  return data;
}

export async function getRecentScans(limit = 10): Promise<RecentScan[]> {
  const res = await fetch(`${API_BASE_URL}/scans/recent?limit=${limit}`);
  return handleJsonResponse<RecentScan[]>(res);
}

export function getScanImageUrl(scanId: number) {
  return `${API_BASE_URL}/scans/${scanId}/image`;
}

export async function createAnnotationSubmission(
  scanId: number,
  annotations: Array<{
    action: "RELABEL" | "REMOVE" | "ADJUST_BOX" | "ADD" | "CONFIRM";
    source_detection_id?: number | null;
    final_label?: string;
    final_x1?: number;
    final_y1?: number;
    final_x2?: number;
    final_y2?: number;
  }>,
): Promise<CreateAnnotationSubmissionResponse> {
  const res = await fetch(`${API_BASE_URL}/scans/${scanId}/annotation-submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ annotations }),
  });
  return handleJsonResponse<CreateAnnotationSubmissionResponse>(res);
}

export async function getAnnotationSubmissions(status?: AnnotationStatus): Promise<AnnotationSubmission[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fetch(`${API_BASE_URL}/annotation-submissions${query}`);
  return handleJsonResponse<AnnotationSubmission[]>(res);
}

export async function getAnnotationStats(): Promise<AnnotationStats> {
  const res = await fetch(`${API_BASE_URL}/annotation-submissions/stats`);
  return handleJsonResponse<AnnotationStats>(res);
}

export async function getAIProgress(): Promise<AIProgressResponse> {
  const res = await fetch(`${API_BASE_URL}/ai-progress`);
  return handleJsonResponse<AIProgressResponse>(res);
}

export async function startCandidateTraining(): Promise<LifecycleJob> {
  const res = await fetch(`${API_BASE_URL}/model-lifecycle/train`, { method: "POST" });
  return handleJsonResponse<LifecycleJob>(res);
}

export async function startCandidateComparison(version: string): Promise<LifecycleJob> {
  const res = await fetch(`${API_BASE_URL}/model-lifecycle/candidates/${encodeURIComponent(version)}/compare`, { method: "POST" });
  return handleJsonResponse<LifecycleJob>(res);
}

export async function getLifecycleJob(jobId: string): Promise<LifecycleJob> {
  const res = await fetch(`${API_BASE_URL}/model-lifecycle/jobs/${encodeURIComponent(jobId)}`);
  return handleJsonResponse<LifecycleJob>(res);
}

export async function promoteCandidate(version: string, comparisonId: string) {
  const res = await fetch(`${API_BASE_URL}/models/${encodeURIComponent(version)}/promote`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comparison_id: comparisonId }),
  });
  return handleJsonResponse<{ ok: boolean; active_version: string }>(res);
}

export async function rollbackModel(version: string) {
  const res = await fetch(`${API_BASE_URL}/models/${encodeURIComponent(version)}/rollback`, { method: "POST" });
  return handleJsonResponse<{ ok: boolean; active_version: string }>(res);
}

export async function getAnnotationSubmission(submissionId: number): Promise<AnnotationSubmissionDetail> {
  const res = await fetch(`${API_BASE_URL}/annotation-submissions/${submissionId}`);
  return handleJsonResponse<AnnotationSubmissionDetail>(res);
}

export async function moderateAnnotationSubmission(
  submissionId: number,
  status: "approved" | "rejected",
): Promise<AnnotationSubmission> {
  const res = await fetch(`${API_BASE_URL}/annotation-submissions/${submissionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const data = await handleJsonResponse<{ ok: boolean; submission: AnnotationSubmission }>(res);
  return data.submission;
}

export async function updateAnnotationLabel(annotationId: number, finalLabel: string): Promise<AnnotationItem> {
  const res = await fetch(`${API_BASE_URL}/annotations/${annotationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ final_label: finalLabel }),
  });
  const data = await handleJsonResponse<{ ok: boolean; annotation: AnnotationItem }>(res);
  return data.annotation;
}

export async function updateAnnotationBox(
  annotationId: number,
  box: { x1: number; y1: number; x2: number; y2: number },
): Promise<AnnotationItem> {
  const res = await fetch(`${API_BASE_URL}/annotations/${annotationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      final_x1: box.x1,
      final_y1: box.y1,
      final_x2: box.x2,
      final_y2: box.y2,
    }),
  });
  const data = await handleJsonResponse<{ ok: boolean; annotation: AnnotationItem }>(res);
  return data.annotation;
}

export async function analyzeFreshness(imageUri: string): Promise<FreshnessAnalysisResponse> {
  const formData = new FormData();
  formData.append("file", {
    uri: imageUri,
    name: "freshness-analysis.jpg",
    type: "image/jpeg",
  } as any);

  const res = await fetch(`${API_BASE_URL}/freshness/analyze`, {
    method: "POST",
    body: formData,
  });
  return handleJsonResponse<FreshnessAnalysisResponse>(res);
}

export async function updateInventoryBatchRemaining(batchId: number, remainingPercent: number) {
  const res = await fetch(`${API_BASE_URL}/inventory/batches/${batchId}/remaining`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remaining_percent: remainingPercent }),
  });
  return handleJsonResponse<{ ok: boolean; batch: InventoryBatchItem }>(res);
}

export async function uploadProductRepresentativeImage(itemId: number, imageUri: string) {
  const formData = new FormData();
  formData.append("file", {
    uri: imageUri,
    name: "product-reference.jpg",
    type: "image/jpeg",
  } as any);
  const res = await fetch(`${API_BASE_URL}/items/${itemId}/representative-image`, {
    method: "POST",
    body: formData,
  });
  return handleJsonResponse<{ ok: boolean; quality_score: number }>(res);
}

export type OutlinePreparationJob = {
  job_id: string;
  status: "queued" | "running" | "complete" | "error";
  phase: string;
  message: string;
  current_product?: string | null;
  total: number;
  processed: number;
  ready: number;
  skipped: number;
  failed: number;
  progress: number;
};

let currentOutlinePreparationJobId: string | null = null;

export async function startOutlinePreparation(forceNewCheck = false): Promise<OutlinePreparationJob> {
  if (!forceNewCheck && currentOutlinePreparationJobId) {
    try {
      return await getOutlinePreparationJob(currentOutlinePreparationJobId);
    } catch {
      currentOutlinePreparationJobId = null;
    }
  }
  const res = await fetch(`${API_BASE_URL}/outlines/prepare`, { method: "POST" });
  const job = await handleJsonResponse<OutlinePreparationJob>(res);
  currentOutlinePreparationJobId = job.job_id;
  return job;
}

export async function getOutlinePreparationJob(jobId: string): Promise<OutlinePreparationJob> {
  const res = await fetch(`${API_BASE_URL}/outlines/jobs/${jobId}`);
  return handleJsonResponse<OutlinePreparationJob>(res);
}

export async function updateInventoryBatchExpiry(batchId: number, expiryDate: string) {
  const res = await fetch(`${API_BASE_URL}/inventory/batches/${batchId}/expiry`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiry_date: expiryDate }),
  });
  return handleJsonResponse<{ ok: boolean }>(res);
}

export async function removeInventoryBatch(batchId: number) {
  const res = await fetch(`${API_BASE_URL}/inventory/batches/${batchId}/remove`, {
    method: "POST",
  });
  return handleJsonResponse<{ ok: boolean; removed_quantity: number }>(res);
}

export async function removeInventoryBatchQuantity(batchId: number, quantity: number) {
  const res = await fetch(`${API_BASE_URL}/inventory/batches/${batchId}/remove-quantity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity }),
  });
  return handleJsonResponse<{ ok: boolean; removed_quantity: number; remaining_quantity: number }>(res);
}

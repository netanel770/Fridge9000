import type {
  AnnotationItem,
  AnnotationStats,
  AnnotationStatus,
  AnnotationSubmission,
  AnnotationSubmissionDetail,
  CreateAnnotationSubmissionResponse,
  ManualAnnotationImageUpload,
} from "../../types/api";
import { apiUrl, JSON_HEADERS, requestJson } from "./client";
import { appendUploadFile } from "./upload";

export async function uploadManualAnnotationImage(
  imageUri: string,
  fileName = "manual-annotation.jpg",
  mimeType = "image/jpeg",
): Promise<ManualAnnotationImageUpload> {
  const formData = new FormData();

  await appendUploadFile(
    formData,
    "file",
    imageUri,
    fileName,
    mimeType,
  );

  return requestJson<ManualAnnotationImageUpload>(
    "/annotation-images/upload",
    {
      method: "POST",
      body: formData,
    },
  );
}

export function createAnnotationSubmission(
  scanId: number,
  annotations: {
    action: "RELABEL" | "REMOVE" | "ADJUST_BOX" | "ADD" | "CONFIRM";
    source_detection_id?: number | null;
    final_label?: string;
    final_x1?: number;
    final_y1?: number;
    final_x2?: number;
    final_y2?: number;
  }[],
): Promise<CreateAnnotationSubmissionResponse> {
  return requestJson<CreateAnnotationSubmissionResponse>(
    `/scans/${scanId}/annotation-submissions`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ annotations }),
    },
  );
}

export function getAnnotationSubmissions(
  status?: AnnotationStatus,
  includeArchived = false,
): Promise<AnnotationSubmission[]> {
  const params = new URLSearchParams();

  if (status) params.set("status", status);
  if (includeArchived) params.set("include_archived", "true");

  const serializedParams = params.toString();
  const query = serializedParams ? `?${serializedParams}` : "";

  return requestJson<AnnotationSubmission[]>(
    `/annotation-submissions${query}`,
  );
}

export function getAnnotationStats(): Promise<AnnotationStats> {
  return requestJson<AnnotationStats>("/annotation-submissions/stats");
}

export function getAnnotationSubmission(
  submissionId: number,
): Promise<AnnotationSubmissionDetail> {
  return requestJson<AnnotationSubmissionDetail>(
    `/annotation-submissions/${submissionId}`,
  );
}

export function getMyAnnotationSubmissions(
  status?: AnnotationStatus,
): Promise<AnnotationSubmission[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";

  return requestJson<AnnotationSubmission[]>(
    `/annotation-submissions/mine${query}`,
  );
}

export function getMyAnnotationSubmission(
  submissionId: number,
): Promise<AnnotationSubmissionDetail> {
  return requestJson<AnnotationSubmissionDetail>(
    `/annotation-submissions/mine/${submissionId}`,
  );
}

export function getAnnotationSubmissionImageUrl(submissionId: number) {
  return apiUrl(`/annotation-submissions/${submissionId}/image`);
}

export async function moderateAnnotationSubmission(
  submissionId: number,
  status: "approved" | "rejected",
): Promise<AnnotationSubmission> {
  const data = await requestJson<{
    ok: boolean;
    submission: AnnotationSubmission;
  }>(`/annotation-submissions/${submissionId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ status }),
  });

  return data.submission;
}

export async function manageQuarantinedSubmission(
  submissionId: number,
  action: "quarantine" | "restore" | "archive" | "unarchive",
): Promise<AnnotationSubmission> {
  const data = await requestJson<{
    ok: boolean;
    action: string;
    submission: AnnotationSubmission;
  }>(`/annotation-submissions/${submissionId}/quarantine`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ action }),
  });

  return data.submission;
}

export async function updateAnnotationLabel(
  annotationId: number,
  finalLabel: string,
): Promise<AnnotationItem> {
  const data = await requestJson<{
    ok: boolean;
    annotation: AnnotationItem;
  }>(`/annotations/${annotationId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ final_label: finalLabel }),
  });

  return data.annotation;
}

export async function updateAnnotationBox(
  annotationId: number,
  box: { x1: number; y1: number; x2: number; y2: number },
): Promise<AnnotationItem> {
  const data = await requestJson<{
    ok: boolean;
    annotation: AnnotationItem;
  }>(`/annotations/${annotationId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      final_x1: box.x1,
      final_y1: box.y1,
      final_x2: box.x2,
      final_y2: box.y2,
    }),
  });

  return data.annotation;
}

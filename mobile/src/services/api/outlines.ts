import type { OutlinePreparationJob } from "../../types/api";
import { requestJson } from "./client";

export type { OutlinePreparationJob } from "../../types/api";

let currentOutlinePreparationJobId: string | null = null;

export function uploadProductRepresentativeImage(itemId: number, imageUri: string) {
  const formData = new FormData();
  formData.append("file", {
    uri: imageUri,
    name: "product-reference.jpg",
    type: "image/jpeg",
  } as any);
  return requestJson<{ ok: boolean; quality_score: number }>(`/items/${itemId}/representative-image`, {
    method: "POST",
    body: formData,
  });
}

export async function startOutlinePreparation(forceNewCheck = false): Promise<OutlinePreparationJob> {
  if (!forceNewCheck && currentOutlinePreparationJobId) {
    try {
      return await getOutlinePreparationJob(currentOutlinePreparationJobId);
    } catch {
      currentOutlinePreparationJobId = null;
    }
  }
  const job = await requestJson<OutlinePreparationJob>("/outlines/prepare", { method: "POST" });
  currentOutlinePreparationJobId = job.job_id;
  return job;
}

export function getOutlinePreparationJob(jobId: string): Promise<OutlinePreparationJob> {
  return requestJson<OutlinePreparationJob>(`/outlines/jobs/${jobId}`);
}

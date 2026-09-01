import type { OutlinePreparationJob } from "../../types/api";
import { requestJson } from "./client";
import { appendUploadFile } from "./upload";

export type { OutlinePreparationJob } from "../../types/api";

let currentOutlinePreparationJobId: string | null = null;

export async function uploadProductRepresentativeImage(
  itemId: number,
  imageUri: string,
) {
  const formData = new FormData();

  await appendUploadFile(
    formData,
    "file",
    imageUri,
    "product-reference.jpg",
    "image/jpeg",
  );

  return requestJson<{ ok: boolean; quality_score: number; outline_revision: string }>(
    `/items/${itemId}/representative-image`,
    {
      method: "POST",
      body: formData,
    },
  );
}

export async function startOutlinePreparation(
  forceNewCheck = false,
): Promise<OutlinePreparationJob> {
  if (!forceNewCheck && currentOutlinePreparationJobId) {
    try {
      return await getOutlinePreparationJob(currentOutlinePreparationJobId);
    } catch {
      currentOutlinePreparationJobId = null;
    }
  }

  const job = await requestJson<OutlinePreparationJob>("/outlines/prepare", {
    method: "POST",
  });

  currentOutlinePreparationJobId = job.job_id;
  return job;
}

export function getOutlinePreparationJob(
  jobId: string,
): Promise<OutlinePreparationJob> {
  return requestJson<OutlinePreparationJob>(`/outlines/jobs/${jobId}`);
}

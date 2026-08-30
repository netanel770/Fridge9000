import {
  ApiError,
  normalizeApiError,
  requestJsonResponse,
} from "./client";
import { appendUploadFile } from "./upload";

export async function uploadReceiptPdf(file: any) {
  const formData = new FormData();

  await appendUploadFile(
    formData,
    "file",
    file.uri,
    file.name || "receipt.jpg",
    file.mimeType || "image/jpeg",
  );

  const { data, response } = await requestJsonResponse<any>(
    "/receipts/upload",
    {
      method: "POST",
      body: formData,
    },
  );

  if (data.ok === false) {
    throw new ApiError(
      normalizeApiError(data, "Receipt upload failed"),
      response.status,
      data,
    );
  }

  return data;
}

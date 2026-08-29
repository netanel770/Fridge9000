import { ApiError, normalizeApiError, requestJsonResponse } from "./client";

export async function uploadReceiptPdf(file: any) {
  const formData = new FormData();
  formData.append("file", {
    uri: file.uri,
    name: file.name || "receipt.jpg",
    type: file.mimeType || "image/jpeg",
  } as any);

  const { data, response } = await requestJsonResponse<any>("/receipts/upload", {
    method: "POST",
    body: formData,
  });
  if (data.ok === false) {
    throw new ApiError(normalizeApiError(data, "Receipt upload failed"), response.status, data);
  }
  return data;
}

import type { InventoryBatchItem, InventoryItem, ManualInventoryResponse } from "../../types/api";
import { ApiError, JSON_HEADERS, normalizeApiError, requestJson, requestJsonResponse } from "./client";
import { appendUploadFile } from "./upload";

export type { ManualInventoryResponse } from "../../types/api";

export function getInventory(signal?: AbortSignal): Promise<InventoryItem[]> {
  return requestJson<InventoryItem[]>("/inventory", { signal });
}

export function getInventoryBatches(signal?: AbortSignal): Promise<InventoryBatchItem[]> {
  return requestJson<InventoryBatchItem[]>("/inventory/batches", { signal });
}

export function getAllInventory(): Promise<InventoryItem[]> {
  return requestJson<InventoryItem[]>("/inventory/all");
}

export async function searchInventoryItems(query: string) {
  const inventory = await getInventory();
  return inventory.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
}

export async function manualInventoryUpdate(
  itemName: string,
  action: "Added" | "Removed",
  quantity: number,
  expiryDate: string,
  expirySource: "manual" | "estimated" = "manual",
) {
  const withoutExpiry = action === "Removed" && expiryDate === "__NO_EXPIRY__";
  const { data, response } = await requestJsonResponse<any>("/inventory/manual", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      item_name: itemName,
      action,
      quantity,
      expiry_date: withoutExpiry ? null : expiryDate,
      expiry_source: expirySource,
      without_expiry: withoutExpiry,
    }),
  });
  if (data.ok === false) {
    throw new ApiError(normalizeApiError(data, "Manual inventory update failed"), response.status, data);
  }
  return data;
}

export async function addInventoryItem(
  itemName: string,
  quantity: number,
  signal?: AbortSignal,
): Promise<ManualInventoryResponse> {
  const { data, response } = await requestJsonResponse<ManualInventoryResponse>("/inventory/manual", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ item_name: itemName, action: "Added", quantity }),
    signal,
  });
  if (!data.ok) {
    throw new ApiError(normalizeApiError(data, "Inventory update failed"), response.status, data);
  }
  return data;
}

export async function updateInventoryByImage(imageUri: string, action: "Added" | "Removed") {
  const formData = new FormData();
  await appendUploadFile(formData, "file", imageUri, "inventory-image.jpg", "image/jpeg");
  return requestJson<any>(`/inventory/image/update?action=${action}`, {
    method: "POST",
    body: formData,
  });
}

export function updateInventoryBatchRemaining(batchId: number, remainingPercent: number) {
  return requestJson<{ ok: boolean; batch: InventoryBatchItem }>(`/inventory/batches/${batchId}/remaining`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ remaining_percent: remainingPercent }),
  });
}

export function updateInventoryBatchExpiry(batchId: number, expiryDate: string) {
  return requestJson<{ ok: boolean }>(`/inventory/batches/${batchId}/expiry`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ expiry_date: expiryDate }),
  });
}

export function removeInventoryBatch(batchId: number) {
  return requestJson<{ ok: boolean; removed_quantity: number }>(`/inventory/batches/${batchId}/remove`, {
    method: "POST",
  });
}

export function removeInventoryBatchQuantity(batchId: number, quantity: number) {
  return requestJson<{ ok: boolean; removed_quantity: number; remaining_quantity: number }>(
    `/inventory/batches/${batchId}/remove-quantity`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ quantity }),
    },
  );
}

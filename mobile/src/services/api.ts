import { API_BASE_URL } from "./config";
import type {
  InventoryItem,
  AlertItem,
  EventItem,
  LatestScan,
  DetectionItem,
  ReviewItem,
  UploadScanResponse,
} from "../types/api";

async function handleJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Request failed");
  }
  return response.json();
}

export async function getInventory(): Promise<InventoryItem[]> {
  const res = await fetch(`${API_BASE_URL}/inventory`);
  return handleJsonResponse<InventoryItem[]>(res);
}

export async function getAllInventory() {
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
  quantity = 1
) {
  const res = await fetch(`${API_BASE_URL}/inventory/manual`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      item_name: itemName,
      action,
      quantity,
    }),
  });

  const data = await res.json();

  if (!res.ok || data.ok === false) {
    throw new Error(data.detail || data.error || "Manual inventory update failed");
  }

  return data;
}
export async function getAlerts(): Promise<AlertItem[]> {
  const res = await fetch(`${API_BASE_URL}/alerts`);
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
  mode: "Added" | "Removed"
) {
  const res = await fetch(`${API_BASE_URL}/scans/${scanId}/review`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode,
      items,
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


export async function uploadReceiptPdf(fileUri: string) {
  const formData = new FormData();

  formData.append("file", {
    uri: fileUri,
    name: "receipt.pdf",
    type: "application/pdf",
  } as any);

  const res = await fetch(`${API_BASE_URL}/receipts/upload`, {
    method: "POST",
    body: formData,
  });

  const data = await res.json();

  if (!res.ok || data.ok === false) {
    throw new Error(data.detail || data.error || "Receipt upload failed");
  }

  return data;
}
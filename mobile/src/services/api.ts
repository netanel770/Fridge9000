import { API_BASE_URL } from "./config";
import { Platform } from "react-native";


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

export async function submitReview(scanId: number, items: ReviewItem[]) {
  const res = await fetch(`${API_BASE_URL}/scans/${scanId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });

  return handleJsonResponse(res);
}

export async function uploadScanImage(imageUri: string) {
  const formData = new FormData();

  if (Platform.OS === "web") {
    const response = await fetch(imageUri);
    const blob = await response.blob();

    formData.append("file", blob, "fridge-scan.jpg");
  } else {
    formData.append("file", {
      uri: imageUri,
      name: "fridge-scan.jpg",
      type: "image/jpeg",
    } as any);
  }

  // STEP 1: upload image
  const uploadRes = await fetch(`${API_BASE_URL}/door/closed/upload`, {
    method: "POST",
    body: formData,
  });

  const upload = (await handleJsonResponse(uploadRes)) as {
  ok: boolean;
  image_ref: string;
  };

  if (!upload?.image_ref) {
    throw new Error("Upload failed: missing image_ref");
  }

  // STEP 2: process scan (THIS CREATES scan_id)
  const scanRes = await fetch(`${API_BASE_URL}/door/closed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_ref: upload.image_ref,
    }),
  });

  return await handleJsonResponse(scanRes);
}
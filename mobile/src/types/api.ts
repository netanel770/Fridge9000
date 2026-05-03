export type InventoryItem = {
  id: number;
  name: string;
  category: string;
  quantity: number;
  status: "OK" | "LOW" | "MISSING";
  last_updated: string;
};

export type AlertItem = {
  id: number;
  name: string;
  category: string;
  quantity: number;
  status: "LOW" | "MISSING";
  last_updated: string;
};

export type EventItem = {
  id: number;
  action: "Added" | "Removed";
  confidence: number;
  created_at: string;
  item_name: string;
  item_category: string;
  scan_id: number | null;
};

export type LatestScan = {
  id: number;
  created_at: string;
  image_ref: string;
  delta_skipped: boolean;
};

export type DetectionItem = {
  label: string;
  count: number;
};


export type ReviewItem = {
  original_label: string;
  final_label: string;
  included: boolean;
  count: number;
  confidence?: number; 
};

export type UploadScanResponse = {
  ok: boolean;
  scan_id?: number;
  prev_scan_id?: number | null;
  added?: string[];
  removed?: string[];
  events_created?: number;
  error?: string;
};
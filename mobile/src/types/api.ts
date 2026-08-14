export type InventoryItem = {
  id: number;
  name: string;
  category: string;
  quantity: number;
  status: "OK" | "LOW" | "MISSING";
  estimated_quantity?: number;
  last_updated: string;
  expiry_date?: string | null;
  expiry_estimate_date?: string | null;
};

export type InventoryBatchItem = {
  id: number;
  item_id: number;
  name: string;
  category: string;
  quantity: number;
  expiry_date?: string | null;
  expiry_estimate_date?: string | null;
  expiry_source?: string | null;
  open_unit_remaining_percent?: number | null;
  created_at: string;
  last_updated: string;
};

export type AlertItem = {
  id: number;
  item_id: number;
  batch_id?: number | null;
  name: string;
  category: string;
  quantity: number;
  status: "LOW" | "MISSING" | "EXPIRING" | "EXPIRED";
  alert_type: "stock" | "expiry";
  last_updated: string;
  expiry_date?: string | null;
};

export type EventItem = {
  id: number;
  action: "Added" | "Removed";
  confidence: number;
  created_at: string;
  item_name: string;
  item_category: string;
  scan_id: number | null;
  quantity_change: number;
};

export type LatestScan = {
  id: number;
  created_at: string;
  image_ref: string;
  delta_skipped: boolean;
};

export type DetectionItem = {
  id: number;
  label: string;
  confidence: number;
  x1?: number | null;
  y1?: number | null;
  x2?: number | null;
  y2?: number | null;
  created_at?: string;
};

export type ReviewItem = {
  id: number;
  original_label: string;
  final_label: string;
  included: boolean;
  confidence?: number;
  x1?: number | null;
  y1?: number | null;
  x2?: number | null;
  y2?: number | null;
  expiry_date?: string | null;
  expiry_estimate_date?: string | null;
  expiry_source?: string | null;
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

export type FreshnessCondition = "Fresh" | "Rotten";

export type FreshnessClassification = {
  class_id: number;
  predicted_class: string;
  item: string;
  condition: FreshnessCondition;
  confidence: number;
  is_rotten: boolean;
};

export type FreshnessCandidate = {
  class_id: number;
  label: string;
  confidence: number;
  recognized: boolean;
};

export type FreshnessAnalysisResponse = {
  ok: boolean;
  classification: FreshnessClassification;
  candidates: FreshnessCandidate[];
  image_url: string;
  message: string;
};

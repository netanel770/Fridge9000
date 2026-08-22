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
  quantity?: number;
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

export type RecentScan = {
  id: number;
  created_at: string;
  image_width: number;
  image_height: number;
  detection_count: number;
};

export type AnnotationAction = "CONFIRM" | "RELABEL" | "ADJUST_BOX" | "ADD" | "REMOVE";
export type AnnotationStatus = "pending" | "approved" | "rejected" | "used";
export type AnnotationTrainingUsage = {
  dataset_version: string;
  training_run_id: string;
  model_version: string;
  model_status: "candidate" | "active" | "rejected" | "archived";
  used_at: string;
};

export type AnnotationItem = {
  id: number;
  submission_id: number;
  source_detection_id?: number | null;
  action: AnnotationAction;
  original_label?: string | null;
  final_label?: string | null;
  original_confidence?: number | null;
  original_x1?: number | null;
  original_y1?: number | null;
  original_x2?: number | null;
  original_y2?: number | null;
  final_x1?: number | null;
  final_y1?: number | null;
  final_x2?: number | null;
  final_y2?: number | null;
  created_at: string;
  training_usages?: AnnotationTrainingUsage[];
};

export type AnnotationSubmission = {
  id: number;
  scan_id: number;
  status: AnnotationStatus;
  image_width: number;
  image_height: number;
  created_at: string;
  reviewed_at?: string | null;
  annotation_count?: number | string;
  training_status?: "used" | "not_used";
  training_usages?: AnnotationTrainingUsage[];
};

export type AnnotationSubmissionDetail = {
  submission: AnnotationSubmission;
  annotations: AnnotationItem[];
};

export type AnnotationStats = {
  submissions: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    used: number;
  };
  annotations_by_action: Record<AnnotationAction, number>;
};

export type ModelMetrics = {
  precision: number | null;
  recall: number | null;
  map50: number | null;
  map50_95: number | null;
};

export type LifecycleModel = ModelMetrics & {
  id: number;
  version: string;
  status: "candidate" | "active" | "rejected" | "archived";
  created_at: string;
  dataset_version?: string | null;
  training_run_id?: string | null;
};

export type ModelComparisonSummary = {
  id: string;
  dataset_version: string;
  created_at: string;
  active_metrics: ModelMetrics;
  candidate_metrics: ModelMetrics;
  metric_differences: ModelMetrics;
  comparison_rule: string;
  candidate_outperforms_active: boolean;
  evaluation_parameters?: {
    provider?: string;
    split?: string;
    shared_class_comparison?: {
      available: boolean;
      class_count: number;
      class_ids: number[];
      class_names: string[];
      active_metrics?: ModelMetrics;
      candidate_metrics?: ModelMetrics;
      metric_differences?: ModelMetrics;
      candidate_outperforms_active?: boolean;
      note?: string;
    };
  };
};

export type AIProgressResponse = {
  active_model: LifecycleModel;
  latest_candidate?: LifecycleModel | null;
  comparison?: ModelComparisonSummary | null;
  archived_models: LifecycleModel[];
  contributions: {
    total_approved: number;
    used_in_training: number;
    approved_waiting: number;
  };
  training_history: {
    training_run_id: string;
    dataset_version: string;
    started_at: string;
    ended_at?: string | null;
    status: "running" | "completed" | "failed" | "interrupted";
    model_version?: string | null;
  }[];
  actions: {
    can_train: boolean;
    can_compare: boolean;
    can_promote: boolean;
    can_rollback: boolean;
  };
};

export type LifecycleJob = {
  job_id: string;
  kind: "TRAIN" | "COMPARE";
  status: "queued" | "running" | "completed" | "failed";
  phase?: "preparing" | "uploading" | "waiting_for_dataset" | "queued" | "running" | "downloading" | "registering" | "completed" | string;
  provider?: string;
  training_run_id?: string;
  dataset_version?: string;
  remote_dataset?: string;
  remote_kernel?: string;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  result?: Record<string, unknown> | null;
  error?: { type: string; message: string } | null;
};

export type CreateAnnotationSubmissionResponse = {
  ok: boolean;
  submission: AnnotationSubmission;
  annotations: AnnotationItem[];
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

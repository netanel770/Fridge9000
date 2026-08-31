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
  image_width?: number;
  image_height?: number;
  prev_scan_id?: number | null;
  added?: string[];
  removed?: string[];
  events_created?: number;
  error?: string;
};

export type PublicUser = {
  id: number;
  email: string;
  display_name: string | null;
  is_active: boolean;
  is_system_admin: boolean;
  created_at: string;
  updated_at: string;
};

export type AuthSessionResponse = {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  access_token_expires_at: string;
  refresh_token_expires_at: string;
  user: PublicUser;
};

export type HouseholdRole = "OWNER" | "MANAGER" | "MEMBER";
export type HouseholdStatus = "PENDING" | "ACTIVE" | "REJECTED" | "REMOVED";
export type HouseholdMembership = {
  fridge_id: number;
  fridge_name: string;
  role: HouseholdRole;
  status: HouseholdStatus;
};

export type HouseholdMember = {
  user_id: number;
  email: string;
  display_name: string | null;
  role: HouseholdRole;
  status: HouseholdStatus;
  requested_at: string;
  reviewed_at: string | null;
};

export type HouseholdMembersResponse = {
  fridge_id: number;
  join_code: string | null;
  members: HouseholdMember[];
};

export type ManualAnnotationImageUpload = {
  ok: boolean;
  scan_id: number;
  image_width: number;
  image_height: number;
  source: "manual_annotation";
  image_url: string;
  created_at: string;
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
export type AnnotationTrainingState = "eligible" | "experimental" | "trusted" | "quarantined";
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
  archived_at?: string | null;
  annotation_count?: number | string;
  training_status?: "used" | "not_used";
  training_state?: AnnotationTrainingState;
  training_lifecycle_state?: AnnotationTrainingState;
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

export type ClassComparison = {
  active_classes: string[];
  candidate_classes: string[];
  shared_classes: string[];
  added_classes: string[];
  removed_classes: string[];
};

export type SharedClassComparison = {
  available: boolean;
  classes: string[];
  class_count: number;
  class_names: string[];
  unavailable_classes: string[];
  active_metrics?: ModelMetrics;
  candidate_metrics?: ModelMetrics;
  metric_differences?: ModelMetrics;
  candidate_outperforms_active?: boolean;
  note?: string;
};

export type AddedClassMetrics = {
  available: boolean;
  classes: string[];
  unavailable_classes: string[];
  aggregate?: ModelMetrics;
  per_class: Record<string, ModelMetrics>;
  note?: string;
};

export type PromotionReason = {
  code: "comparison_missing" | "stale_comparison" | "candidate_lost" | "removed_classes" | "missing_shared_classes" | "shared_class_regression" | "added_class_quality" | "added_class_below_minimum" | "malformed_class_metrics";
  message: string;
  difference?: number;
  maximum_regression?: number;
  value?: number;
  minimum?: number;
  classes?: string[] | Record<string, number>;
  missing_classes?: string[];
  detail?: string;
};

export type PromotionEvaluation = {
  policy: string;
  eligible: boolean;
  comparison_valid: boolean;
  mode: "same_classes" | "expanded_classes" | null;
  stale: boolean;
  thresholds: {
    max_shared_map50_95_regression: number;
    min_added_class_map50_95: number;
    min_added_class_per_class_map50_95: number;
  };
  metrics: {
    active_map50_95?: number;
    candidate_map50_95?: number;
    active_map50?: number;
    candidate_map50?: number;
    shared_active_map50_95?: number;
    shared_candidate_map50_95?: number;
    shared_map50_95_difference?: number;
    added_map50_95?: number;
    added_per_class_map50_95?: Record<string, number>;
  };
  reasons: PromotionReason[];
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
  class_comparison: ClassComparison;
  shared_class_comparison: SharedClassComparison;
  added_class_metrics: AddedClassMetrics;
  promotion_evaluation: PromotionEvaluation;
  evaluation_parameters?: {
    provider?: string;
    split?: string;
  };
};

export type UserModelComparison = {
  id: string;
  dataset_version: string;
  created_at: string;
  current_model_id: number;
  previous_model_id: number;
  stored_active_model_id: number;
  stored_candidate_model_id: number;
  current_metrics: ModelMetrics;
  previous_metrics: ModelMetrics;
  metric_differences: ModelMetrics;
  metric_difference_direction: "current_minus_previous" | "previous_minus_current";
  class_comparison: {
    current_classes: string[];
    previous_classes: string[];
    shared_classes: string[];
    only_in_current: string[];
    only_in_previous: string[];
  };
  shared_class_comparison: SharedClassComparison;
  added_class_metrics: AddedClassMetrics;
  comparison_rule: string;
  candidate_outperforms_active: boolean;
};

export type UserModelOverview = {
  active_model: LifecycleModel | null;
  previous_model: LifecycleModel | null;
  comparison: UserModelComparison | null;
};

export type CandidateState =
  | "none"
  | "needs_comparison"
  | "comparison_stale"
  | "comparison_invalid"
  | "not_eligible"
  | "eligible";

export type RollbackTarget = LifecycleModel & {
  last_activated_at?: string | null;
  archived_at?: string | null;
  supported_classes: string[];
  supported_product_count: number;
  classes_available: boolean;
};

export type AIProgressResponse = {
  active_model: LifecycleModel;
  active_classes: string[];
  active_model_classes: {
    available: boolean;
    count: number;
    classes: string[];
  };
  candidate?: LifecycleModel | null;
  candidate_state: CandidateState;
  latest_candidate?: LifecycleModel | null;
  comparison?: ModelComparisonSummary | null;
  promotion_evaluation: PromotionEvaluation;
  archived_models: LifecycleModel[];
  rollback_targets: RollbackTarget[];
  model_display_names: Record<string, string>;
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
    model_id?: number | null;
    model_version?: string | null;
    submission_count: number;
    annotation_count: number;
    training_parameters?: Record<string, unknown>;
  }[];
  actions: {
    can_train: boolean;
    can_compare: boolean;
    can_promote: boolean;
    can_reject: boolean;
    can_rollback: boolean;
  };
};

export type RollbackComparison = {
  comparison_id: string;
  comparison_type: "rollback_target_vs_active";
  created_at: string;
  dataset_version: string;
  dataset_content_sha256: string;
  validation_split_sha256: string;
  evaluation_parameters: Record<string, unknown>;
  active_model: Pick<LifecycleModel, "id" | "version">;
  rollback_target: Pick<LifecycleModel, "id" | "version">;
  active_metrics: ModelMetrics;
  rollback_target_metrics: ModelMetrics;
  metric_differences: ModelMetrics;
  class_comparison: {
    active_classes: string[];
    rollback_target_classes: string[];
    shared_classes: string[];
    only_in_active: string[];
    only_in_rollback_target: string[];
  };
  shared_class_comparison: SharedClassComparison;
  added_class_metrics: AddedClassMetrics;
  comparison_rule: string;
  candidate_outperforms_active: boolean;
  summary_path?: string | null;
};

export type RollbackComparisonResponse = {
  available: boolean;
  comparison: RollbackComparison | null;
};

export type LifecycleJob = {
  job_id: string;
  kind: "TRAIN" | "COMPARE";
  status: "queued" | "running" | "completed" | "failed";
  phase?: "preparing" | "uploading" | "waiting_for_dataset" | "queued" | "running" | "downloading" | "registering" | "completed" | string;
  provider?: string;
  training_run_id?: string;
  dataset_version?: string;
  selected_submission_ids?: number[] | null;
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

export type ManualInventoryResponse = {
  ok: boolean;
  item_id?: number;
  new_quantity?: number;
  error?: string;
};

export type OutlinePreparationJob = {
  job_id: string;
  status: "queued" | "running" | "complete" | "error";
  phase: string;
  message: string;
  current_product?: string | null;
  total: number;
  processed: number;
  ready: number;
  skipped: number;
  failed: number;
  progress: number;
};

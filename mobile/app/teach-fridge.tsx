import { useEffect, useMemo, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";

import { AppButton, Card, EmptyState, ScreenHeader, StatusBadge } from "../src/components/ui";
import { DetectionImageViewer } from "../src/components/DetectionImageViewer";
import { BoundingBoxEditor } from "../src/components/BoundingBoxEditor";
import { ProductLabelInput, uniqueProductLabels } from "../src/components/ProductLabelInput";
import { lifecyclePhaseLabel, useLifecycleJob } from "../src/components/LifecycleJobProvider";
import { createAnnotationSubmission, getAIProgress, getAllInventory, getAnnotationSubmission, getAnnotationSubmissions, getRecentScans, getRollbackTargetComparison, getScan, getScanDetections, getScanImageUrl, manageQuarantinedSubmission, moderateAnnotationSubmission, promoteCandidate, rejectCandidate, rollbackModel, startCandidateComparison, startCandidateTraining, updateAnnotationBox, updateAnnotationLabel } from "../src/services/api";
import type { AIProgressResponse, AnnotationItem, AnnotationStatus, AnnotationSubmission, AnnotationSubmissionDetail, AnnotationTrainingState, CandidateState, DetectionItem, InventoryItem, ModelMetrics, PromotionReason, RecentScan, RollbackComparisonResponse, RollbackTarget } from "../src/types/api";
import { areImageDimensionsCompatible, getMinimumAnnotationBoxSize } from "../src/utils/imageCoordinates";
import type { ImageBoundingBox } from "../src/utils/imageCoordinates";
import { colors, radius, spacing, typography } from "../src/theme";

type TeachTab = "Suggestions" | "Contributions" | "AI Progress";

const TABS: TeachTab[] = ["Suggestions", "Contributions", "AI Progress"];
const CONTRIBUTION_FILTERS = ["All", "Pending", "Approved", "Rejected", "Used"] as const;
type ContributionFilter = typeof CONTRIBUTION_FILTERS[number];
type ContributionSort = "Newest" | "Oldest" | "Product";
type Contribution = { submission: AnnotationSubmission; annotation: AnnotationItem };
type ModelIdentity = { id?: number | null; version?: string | null };
type BoxEditorTarget = {
  source: "suggestion" | "contribution" | "add";
  scanId: number;
  imageWidth: number;
  imageHeight: number;
  detectionId?: number;
  annotationId?: number;
  label: string;
  originalBox: ImageBoundingBox | null;
  box: ImageBoundingBox | null;
};

function statusTone(status: AnnotationStatus): "warning" | "success" | "danger" | "info" {
  if (status === "pending") return "warning";
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "info";
}

function actionTitle(action: AnnotationItem["action"]) {
  return action === "RELABEL" ? "Label correction" : action === "REMOVE" ? "False positive" : action === "ADJUST_BOX" ? "Box adjustment" : action === "ADD" ? "Missed product" : "Confirmed detection";
}

function contributionChange(annotation: AnnotationItem) {
  if (annotation.action === "CONFIRM") return "Confirmed";
  if (annotation.action === "RELABEL") return `Changed to ${annotation.final_label || "a corrected product"}`;
  if (annotation.action === "REMOVE") return "Marked incorrect";
  if (annotation.action === "ADJUST_BOX") return "Adjusted product area";
  return `Added ${annotation.final_label || "unlabeled product"}`;
}

function contributionProductLabel(annotation: AnnotationItem) {
  return annotation.final_label?.trim() || annotation.original_label?.trim() || "Unlabeled product";
}

function annotationDetection(annotation: AnnotationItem): DetectionItem {
  return {
    id: annotation.id,
    label: contributionProductLabel(annotation),
    confidence: annotation.original_confidence ?? 0,
    x1: annotation.final_x1 ?? annotation.original_x1,
    y1: annotation.final_y1 ?? annotation.original_y1,
    x2: annotation.final_x2 ?? annotation.original_x2,
    y2: annotation.final_y2 ?? annotation.original_y2,
  };
}

function hasDrawableBox(detection: DetectionItem, imageWidth: number, imageHeight: number) {
  const { x1, y1, x2, y2 } = detection;
  if (![x1, y1, x2, y2, imageWidth, imageHeight].every((value) => value != null && Number.isFinite(value))) return false;
  return imageWidth > 0 && imageHeight > 0
    && Math.min(imageWidth, x2!) > Math.max(0, x1!)
    && Math.min(imageHeight, y2!) > Math.max(0, y1!);
}

function contributionStatus(status: AnnotationStatus, used: boolean) {
  if (used || status === "used") return "USED IN TRAINING";
  if (status === "pending") return "PENDING REVIEW";
  if (status === "approved") return "READY TO TRAIN";
  return "REJECTED";
}

function trainingState(submission: AnnotationSubmission): AnnotationTrainingState {
  return submission.training_lifecycle_state || submission.training_state || "eligible";
}

function trainingStateCopy(state: AnnotationTrainingState) {
  if (state === "eligible") return { label: "ELIGIBLE", tone: "success" as const, explanation: "Ready to select for the next candidate." };
  if (state === "experimental") return { label: "EXPERIMENTAL", tone: "warning" as const, explanation: "Currently being evaluated in a candidate." };
  if (state === "trusted") return { label: "TRUSTED", tone: "info" as const, explanation: "Part of the active model's trusted training baseline." };
  return { label: "QUARANTINED", tone: "danger" as const, explanation: "Excluded after its candidate was rejected." };
}

function candidateStateCopy(state: CandidateState) {
  if (state === "needs_comparison") return { label: "NEEDS COMPARISON", tone: "warning" as const, description: "Compare this candidate with the active model before deciding." };
  if (state === "comparison_stale") return { label: "COMPARISON STALE", tone: "warning" as const, description: "The active model changed. Run the candidate comparison again." };
  if (state === "comparison_invalid") return { label: "COMPARISON INVALID", tone: "warning" as const, description: "The saved comparison is incomplete. Retry it before deciding." };
  if (state === "not_eligible") return { label: "NOT ELIGIBLE", tone: "danger" as const, description: "This candidate did not pass the promotion policy." };
  if (state === "eligible") return { label: "ELIGIBLE FOR PROMOTION", tone: "success" as const, description: "This candidate passed the promotion policy." };
  return { label: "NO CANDIDATE", tone: "info" as const, description: "No candidate is currently under evaluation." };
}

const INITIAL_MODEL_VERSION = "fridge9000-production-initial";

function singleAddedClass(classes: string[], baselineClasses: string[]) {
  const baseline = new Set(baselineClasses.map((name) => name.trim().toLocaleLowerCase()));
  const added = [...new Map(
    classes
      .map((name) => name.trim())
      .filter((name) => name && !baseline.has(name.toLocaleLowerCase()))
      .map((name) => [name.toLocaleLowerCase(), name]),
  ).values()];
  return added.length === 1 ? added[0] : null;
}

function readableModelName(model: ModelIdentity | null | undefined, meaningfulClass?: string | null) {
  if (model?.version === INITIAL_MODEL_VERSION) return "Initial Model";
  if (meaningfulClass) {
    const product = meaningfulClass
      .trim()
      .split(/\s+/)
      .map((part) => part ? `${part[0].toLocaleUpperCase()}${part.slice(1).toLocaleLowerCase()}` : part)
      .join(" ");
    if (product) return `${product} Model`;
  }
  return model?.id != null ? `Model ${model.id}` : "Model";
}

function formatMetric(value: number | null | undefined) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatMetricDifference(value: number | null | undefined) {
  if (value == null) return "—";
  const points = value * 100;
  return `${points > 0 ? "+" : ""}${points.toFixed(1)} pp`;
}

function promotionReasonText(reason: PromotionReason) {
  if (reason.code === "shared_class_regression" && reason.difference != null && reason.maximum_regression != null) {
    return `Existing-product performance changed ${formatMetricDifference(reason.difference)}, beyond the allowed ${formatMetricDifference(-reason.maximum_regression)}.`;
  }
  if (reason.code === "added_class_quality" && reason.value != null && reason.minimum != null) {
    return `New-product average is ${formatMetric(reason.value)}; at least ${formatMetric(reason.minimum)} is required.`;
  }
  if (reason.code === "added_class_below_minimum" && reason.classes && !Array.isArray(reason.classes) && reason.minimum != null) {
    const names = Object.keys(reason.classes).join(", ");
    return `${names} must reach at least ${formatMetric(reason.minimum)} mAP50–95.`;
  }
  if (reason.code === "removed_classes" && Array.isArray(reason.classes)) {
    return `Candidate removed support for ${reason.classes.join(", ")}.`;
  }
  return reason.message;
}

function metricVerdict(difference: number | null | undefined) {
  if (difference == null) return "Not available";
  if (Math.abs(difference) < 0.0005) return "Roughly equal";
  return difference > 0 ? "Candidate better" : "Active better";
}

function sharedMap50_95Difference(progress: AIProgressResponse) {
  const policyDifference = progress.promotion_evaluation.metrics.shared_map50_95_difference;
  if (typeof policyDifference === "number" && Number.isFinite(policyDifference)) {
    return policyDifference;
  }

  const comparisonDifference = progress.comparison?.shared_class_comparison.metric_differences?.map50_95;
  return typeof comparisonDifference === "number" && Number.isFinite(comparisonDifference)
    ? comparisonDifference
    : null;
}

function sharedRegressionBadge(progress: AIProgressResponse): {
  label: string;
  tone: "success" | "danger" | "warning";
} {
  const reasons = progress.promotion_evaluation.reasons;

  if (
    progress.promotion_evaluation.stale ||
    reasons.some((reason) => reason.code === "stale_comparison")
  ) {
    return { label: "COMPARISON STALE", tone: "warning" };
  }

  if (reasons.some((reason) => reason.code === "malformed_class_metrics")) {
    return { label: "COMPARISON INVALID", tone: "warning" };
  }

  if (
    reasons.some(
      (reason) =>
        reason.code === "comparison_missing" ||
        reason.code === "missing_shared_classes",
    )
  ) {
    return { label: "COMPARISON INCOMPLETE", tone: "warning" };
  }

  const difference = sharedMap50_95Difference(progress);
  const maximumRegression =
    progress.promotion_evaluation.thresholds.max_shared_map50_95_regression;

  if (
    difference == null ||
    !Number.isFinite(maximumRegression) ||
    maximumRegression < 0
  ) {
    return { label: "COMPARISON UNAVAILABLE", tone: "warning" };
  }

  if (
    reasons.some((reason) => reason.code === "shared_class_regression") ||
    difference < -maximumRegression
  ) {
    return { label: "REGRESSION TOO HIGH", tone: "danger" };
  }

  return { label: "WITHIN ALLOWED REGRESSION", tone: "success" };
}

const METRIC_ROWS: { key: keyof ModelMetrics; label: string }[] = [
  { key: "precision", label: "Precision" },
  { key: "recall", label: "Recall" },
  { key: "map50", label: "mAP50" },
  { key: "map50_95", label: "mAP50–95" },
];

export default function TeachFridgeScreen() {
  const { scanId: requestedScanIdParam, detectionId: requestedDetectionIdParam, addMissed, tab } = useLocalSearchParams<{ scanId?: string; detectionId?: string; addMissed?: string; tab?: string }>();
  const requestedScanId = Number(requestedScanIdParam);
  const requestedDetectionId = Number(requestedDetectionIdParam);
  const hasValidRequestedScan = Number.isInteger(requestedScanId) && requestedScanId > 0;
  const hasTargetedDetection = hasValidRequestedScan && Number.isInteger(requestedDetectionId) && requestedDetectionId > 0;
  const [activeTab, setActiveTab] = useState<TeachTab>(tab === "AI Progress" ? "AI Progress" : "Suggestions");
  const [scans, setScans] = useState<RecentScan[]>([]);
  const [selectedScan, setSelectedScan] = useState<RecentScan | null>(null);
  const [detections, setDetections] = useState<DetectionItem[]>([]);
  const [loadingScans, setLoadingScans] = useState(true);
  const [loadingDetections, setLoadingDetections] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState("");
  const [imageDetection, setImageDetection] = useState<DetectionItem | null>(null);
  const [editDetection, setEditDetection] = useState<DetectionItem | null>(null);
  const [finalLabel, setFinalLabel] = useState("");
  const [inventoryLabels, setInventoryLabels] = useState<InventoryItem[]>([]);
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelError, setLabelError] = useState("");
  const [submissionMessage, setSubmissionMessage] = useState("");
  const [pendingRelabels, setPendingRelabels] = useState<Record<number, { finalLabel: string; submissionId: number }>>({});
  const [removeDetection, setRemoveDetection] = useState<DetectionItem | null>(null);
  const [removingDetectionId, setRemovingDetectionId] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [pendingRemovals, setPendingRemovals] = useState<Record<number, number>>({});
  const [contributionFilter, setContributionFilter] = useState<ContributionFilter>("All");
  const [contributionSearch, setContributionSearch] = useState("");
  const [contributionLabelFilter, setContributionLabelFilter] = useState("");
  const [contributionSort, setContributionSort] = useState<ContributionSort>("Newest");
  const [contributions, setContributions] = useState<Contribution[]>([]);
  const [loadingContributions, setLoadingContributions] = useState(false);
  const [contributionsError, setContributionsError] = useState("");
  const [contributionImage, setContributionImage] = useState<Contribution | null>(null);
  const [editContribution, setEditContribution] = useState<Contribution | null>(null);
  const [contributionLabel, setContributionLabel] = useState("");
  const [contributionEditError, setContributionEditError] = useState("");
  const [savingContribution, setSavingContribution] = useState(false);
  const [contributionMessage, setContributionMessage] = useState("");
  const [boxEditor, setBoxEditor] = useState<BoxEditorTarget | null>(null);
  const [savingBox, setSavingBox] = useState(false);
  const [boxError, setBoxError] = useState("");
  const [pendingBoxes, setPendingBoxes] = useState<Record<number, number>>({});
  const [confirmDetection, setConfirmDetection] = useState<DetectionItem | null>(null);
  const [confirmingDetectionId, setConfirmingDetectionId] = useState<number | null>(null);
  const [confirmError, setConfirmError] = useState("");
  const [pendingConfirms, setPendingConfirms] = useState<Record<number, number>>({});
  const [moderationSubmissions, setModerationSubmissions] = useState<AnnotationSubmissionDetail[]>([]);
  const [loadingModeration, setLoadingModeration] = useState(false);
  const [moderationError, setModerationError] = useState("");
  const [moderationMessage, setModerationMessage] = useState("");
  const [moderatingSubmissionId, setModeratingSubmissionId] = useState<number | null>(null);
  const [moderationDetails, setModerationDetails] = useState<Set<number>>(new Set());
  const [progressStats, setProgressStats] = useState<AIProgressResponse | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [progressError, setProgressError] = useState("");
  const [lifecycleMutation, setLifecycleMutation] = useState<string | null>(null);
  const [mutationMessage, setMutationMessage] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [showModelDetails, setShowModelDetails] = useState(false);
  const [eligibleSubmissions, setEligibleSubmissions] = useState<AnnotationSubmissionDetail[]>([]);
  const [quarantinedSubmissions, setQuarantinedSubmissions] = useState<AnnotationSubmissionDetail[]>([]);
  const [selectedTrainingSubmissions, setSelectedTrainingSubmissions] = useState<Set<number>>(new Set());
  const [selectedQuarantineSubmissions, setSelectedQuarantineSubmissions] = useState<Set<number>>(new Set());
  const [loadingTrainingSelection, setLoadingTrainingSelection] = useState(false);
  const [trainingSelectionError, setTrainingSelectionError] = useState("");
  const [showTrainingSelector, setShowTrainingSelector] = useState(false);
  const [expandedTrainingLabel, setExpandedTrainingLabel] = useState<string | null>(null);
  const [expandedTrainingSubmission, setExpandedTrainingSubmission] = useState<number | null>(null);
  const [showTrainingHistory, setShowTrainingHistory] = useState(false);
  const [showRollbackSelector, setShowRollbackSelector] = useState(false);
  const [selectedRollbackVersion, setSelectedRollbackVersion] = useState<string | null>(null);
  const [rollbackComparisonTarget, setRollbackComparisonTarget] = useState<RollbackTarget | null>(null);
  const [rollbackComparison, setRollbackComparison] = useState<RollbackComparisonResponse | null>(null);
  const [loadingRollbackComparison, setLoadingRollbackComparison] = useState<string | null>(null);
  const [rollbackComparisonError, setRollbackComparisonError] = useState("");
  const [showQuarantine, setShowQuarantine] = useState(false);
  const [expandedQuarantineLabel, setExpandedQuarantineLabel] = useState<string | null>(null);
  const [expandedQuarantineSubmission, setExpandedQuarantineSubmission] = useState<number | null>(null);
  const [focusedQuarantineAnnotation, setFocusedQuarantineAnnotation] = useState<number | null>(null);
  const [quarantineReturnToTraining, setQuarantineReturnToTraining] = useState(false);
  const [quarantineMutation, setQuarantineMutation] = useState<number | null>(null);
  const [quarantineError, setQuarantineError] = useState("");
  const [quarantineMessage, setQuarantineMessage] = useState("");
  const lifecycle = useLifecycleJob();
  const selectionRequest = useRef(0);
  const contributionsRequest = useRef(0);
  const moderationRequest = useRef(0);
  const progressRequest = useRef(0);
  const trainingSelectionRequest = useRef(0);
  const handledRequestedScan = useRef(false);

  async function selectScan(scan: RecentScan) {
    const requestId = ++selectionRequest.current;
    setSelectedScan(scan);
    setImageDetection(null);
    setLoadingDetections(true);
    setSuggestionsError("");
    try {
      const scanDetections = await getScanDetections(scan.id);
      if (selectionRequest.current === requestId) {
        setDetections(hasTargetedDetection && scan.id === requestedScanId
          ? [...scanDetections].sort((left, right) => Number(right.id === requestedDetectionId) - Number(left.id === requestedDetectionId))
          : scanDetections);
      }
    } catch (caught) {
      if (selectionRequest.current === requestId) {
        setDetections([]);
        setSuggestionsError(caught instanceof Error ? caught.message : "Could not load scan detections.");
      }
    } finally {
      if (selectionRequest.current === requestId) setLoadingDetections(false);
    }
  }

  async function loadSuggestions() {
    setLoadingScans(true);
    setSuggestionsError("");
    try {
      const [recent, requestedScan] = await Promise.all([
        getRecentScans(10),
        hasValidRequestedScan ? getScan(requestedScanId) : Promise.resolve(undefined),
      ]);
      setScans(requestedScan && !recent.some((scan) => scan.id === requestedScan.id) ? [requestedScan, ...recent] : recent);
      const initialScan = hasValidRequestedScan ? requestedScan : recent[0];
      if (initialScan) {
        await selectScan(initialScan);
        if (requestedScan && addMissed === "1" && !handledRequestedScan.current) {
          handledRequestedScan.current = true;
          await openAddBoxEditorForScan(requestedScan);
        }
      }
      else {
        setSelectedScan(null);
        setDetections([]);
        if (hasValidRequestedScan) setSuggestionsError(`Scan #${requestedScanId} could not be loaded. Return to Review and try again.`);
      }
    } catch (caught) {
      setSuggestionsError(caught instanceof Error ? caught.message : "Could not load recent scans.");
    } finally {
      setLoadingScans(false);
    }
  }

  useEffect(() => {
    loadSuggestions();
  }, []);

  async function loadContributions() {
    const requestId = ++contributionsRequest.current;
    setLoadingContributions(true);
    setContributionsError("");
    try {
      const submissions = await getAnnotationSubmissions();
      const details = await Promise.all(submissions.map((submission) => getAnnotationSubmission(submission.id)));
      if (contributionsRequest.current === requestId) {
        setContributions(details
          .filter((detail) => trainingState(detail.submission) !== "quarantined")
          .flatMap((detail) => detail.annotations.map((annotation) => ({ submission: detail.submission, annotation }))));
      }
    } catch (caught) {
      if (contributionsRequest.current === requestId) {
        setContributions([]);
        setContributionsError(caught instanceof Error ? caught.message : "Could not load contributions.");
      }
    } finally {
      if (contributionsRequest.current === requestId) setLoadingContributions(false);
    }
  }

  useEffect(() => {
    if (activeTab === "Contributions") {
      loadContributions();
      loadModeration();
    }
  }, [activeTab]);

  async function loadModeration() {
    const requestId = ++moderationRequest.current;
    setLoadingModeration(true);
    setModerationError("");
    try {
      const submissions = await getAnnotationSubmissions("pending");
      const details = await Promise.all(submissions.map((submission) => getAnnotationSubmission(submission.id)));
      if (moderationRequest.current === requestId) setModerationSubmissions(details);
    } catch (caught) {
      if (moderationRequest.current === requestId) {
        setModerationSubmissions([]);
        setModerationError(caught instanceof Error ? caught.message : "Could not load the moderation queue.");
      }
    } finally {
      if (moderationRequest.current === requestId) setLoadingModeration(false);
    }
  }

  async function loadProgress() {
    const requestId = ++progressRequest.current;
    setLoadingProgress(true);
    setProgressError("");
    try {
      const progress = await getAIProgress();
      if (progressRequest.current === requestId) setProgressStats(progress);
    } catch (caught) {
      if (progressRequest.current === requestId) {
        setProgressStats(null);
        setProgressError(caught instanceof Error ? caught.message : "Could not load AI progress statistics.");
      }
    } finally {
      if (progressRequest.current === requestId) setLoadingProgress(false);
    }
  }

  async function loadTrainingSelection() {
    const requestId = ++trainingSelectionRequest.current;
    setLoadingTrainingSelection(true);
    setTrainingSelectionError("");
    try {
      const submissions = await getAnnotationSubmissions();
      const lifecycleSubmissions = submissions.filter((submission) =>
        ["approved", "used"].includes(submission.status) && ["eligible", "quarantined"].includes(trainingState(submission))
      );
      const details = await Promise.all(lifecycleSubmissions.map((submission) => getAnnotationSubmission(submission.id)));
      const eligible = details.filter((detail) => trainingState(detail.submission) === "eligible");
      const quarantined = details.filter((detail) => trainingState(detail.submission) === "quarantined");
      if (trainingSelectionRequest.current !== requestId) return;
      setEligibleSubmissions(eligible);
      setQuarantinedSubmissions(quarantined);
      const eligibleIds = new Set(eligible.map((detail) => detail.submission.id));
      const quarantinedIds = new Set(quarantined.map((detail) => detail.submission.id));
      setSelectedTrainingSubmissions((current) => new Set([...current].filter((id) => eligibleIds.has(id))));
      setSelectedQuarantineSubmissions((current) => new Set([...current].filter((id) => quarantinedIds.has(id))));
    } catch (caught) {
      if (trainingSelectionRequest.current === requestId) {
        setEligibleSubmissions([]);
        setQuarantinedSubmissions([]);
        setSelectedTrainingSubmissions(new Set());
        setSelectedQuarantineSubmissions(new Set());
        setTrainingSelectionError(caught instanceof Error ? caught.message : "Could not load eligible annotations.");
      }
    } finally {
      if (trainingSelectionRequest.current === requestId) setLoadingTrainingSelection(false);
    }
  }

  function confirmPromotion() {
    if (!progressStats?.latest_candidate || !progressStats.comparison) return;
    Alert.alert(`Promote ${candidateModelName}?`, `Make ${candidateModelName} the active production model? ${activeModelName} will remain available for rollback.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Promote", onPress: async () => {
        setLifecycleMutation("Promote Candidate"); setMutationError(""); setMutationMessage("");
        try {
          await promoteCandidate(progressStats.latest_candidate!.version, progressStats.comparison!.id);
          setMutationMessage("Candidate promoted. The previous active model is available for rollback.");
          await Promise.all([loadProgress(), loadTrainingSelection(), loadContributions()]);
        } catch (caught) { setMutationError(caught instanceof Error ? caught.message : "Promotion failed."); }
        finally { setLifecycleMutation(null); }
      } },
    ]);
  }

  function confirmCandidateRejection() {
    if (!progressStats?.latest_candidate) return;
    const version = progressStats.latest_candidate.version;
    Alert.alert(
      `Reject ${candidateModelName}?`,
      "This model will not become active. Its experimental annotations will move to Quarantine for review.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Reject", style: "destructive", onPress: async () => {
          setLifecycleMutation("Reject Candidate"); setMutationError(""); setMutationMessage("");
          try {
            const result = await rejectCandidate(version);
            setMutationMessage(`Candidate rejected. ${result.quarantined_submission_count} experimental submission${result.quarantined_submission_count === 1 ? " was" : "s were"} quarantined.`);
            await Promise.all([loadProgress(), loadTrainingSelection(), loadContributions()]);
          } catch (caught) { setMutationError(caught instanceof Error ? caught.message : "Candidate rejection failed."); }
          finally { setLifecycleMutation(null); }
        } },
      ],
    );
  }

  function startSelectedCandidateTraining() {
    const selectedIds = [...selectedTrainingSubmissions].sort((left, right) => left - right);
    if (!selectedIds.length) return;
    setMutationMessage("");
    setShowTrainingSelector(false);
    lifecycle.runJob("Train Candidate", () => startCandidateTraining(selectedIds));
  }

  function openQuarantine(fromTraining = false) {
    setQuarantineReturnToTraining(fromTraining);
    if (fromTraining) setShowTrainingSelector(false);
    setTimeout(() => setShowQuarantine(true), fromTraining ? 200 : 0);
  }

  function openQuarantineFromTraining() {
    openQuarantine(true);
  }

  function returnToTrainingSelection() {
    setShowQuarantine(false);
    setQuarantineReturnToTraining(false);
    setTimeout(() => setShowTrainingSelector(true), 200);
  }

  async function applyQuarantineAction(submissionId: number, action: "restore" | "reject") {
    setQuarantineMutation(submissionId);
    setQuarantineError("");
    setQuarantineMessage("");
    try {
      await manageQuarantinedSubmission(submissionId, action);
      setExpandedQuarantineSubmission(null);
      setFocusedQuarantineAnnotation(null);
      setQuarantineMessage(action === "restore" ? "Restored to eligible training data." : "Submission permanently rejected.");
      await Promise.all([loadTrainingSelection(), loadProgress(), loadContributions()]);
    } catch (caught) {
      setQuarantineError(caught instanceof Error ? caught.message : "Could not update the submission.");
    } finally {
      setQuarantineMutation(null);
    }
  }

  function confirmPermanentQuarantineRejection(submissionId: number) {
    Alert.alert("Reject submission?", "It will remain excluded from future training.", [
      { text: "Cancel", style: "cancel" },
      { text: "Reject", style: "destructive", onPress: () => applyQuarantineAction(submissionId, "reject") },
    ]);
  }

  function openRollbackSelector() {
    setSelectedRollbackVersion(null);
    setRollbackComparisonTarget(null);
    setRollbackComparison(null);
    setRollbackComparisonError("");
    setShowRollbackSelector(true);
  }

  async function viewRollbackComparison(target: RollbackTarget) {
    setLoadingRollbackComparison(target.version);
    setRollbackComparisonError("");
    try {
      const result = await getRollbackTargetComparison(target.version);
      setRollbackComparisonTarget(target);
      setRollbackComparison(result);
    } catch (caught) {
      setRollbackComparisonError(caught instanceof Error ? caught.message : "Could not load the cached comparison.");
    } finally {
      setLoadingRollbackComparison(null);
    }
  }

  function confirmRollback(version: string) {
    const target = progressStats?.rollback_targets.find((model) => model.version === version);
    const targetName = rollbackTargetDisplayName(target);
    Alert.alert(`Roll back to ${targetName}?`, `Current active model: ${activeModelName}\n\nNew active model: ${targetName}\n\nThis will replace the model currently used for product detection.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Confirm Rollback", style: "destructive", onPress: async () => {
        setLifecycleMutation("Rollback Model"); setMutationError(""); setMutationMessage("");
        try {
          await rollbackModel(version);
          setMutationMessage(`Rolled back to ${targetName}.`);
          setShowRollbackSelector(false);
          setSelectedRollbackVersion(null);
          await Promise.all([loadProgress(), loadTrainingSelection(), loadContributions()]);
        }
        catch (caught) { setMutationError(caught instanceof Error ? caught.message : "Rollback failed."); }
        finally { setLifecycleMutation(null); }
      } },
    ]);
  }

  useEffect(() => {
    if (activeTab === "AI Progress") {
      loadProgress();
      loadTrainingSelection();
    }
  }, [activeTab, lifecycle.completionCount]);

  useEffect(() => {
    if (tab === "AI Progress") setActiveTab("AI Progress");
  }, [tab]);

  async function moderateSubmission(submissionId: number, status: "approved" | "rejected") {
    if (moderatingSubmissionId !== null) return;
    setModeratingSubmissionId(submissionId);
    setModerationError("");
    try {
      await moderateAnnotationSubmission(submissionId, status);
      setModerationSubmissions((current) => current.filter((detail) => detail.submission.id !== submissionId));
      setModerationMessage(`Submission #${submissionId} ${status}. Contributions will show the updated status.`);
    } catch (caught) {
      setModerationError(caught instanceof Error ? caught.message : `Could not mark the submission as ${status}.`);
      await loadModeration();
    } finally {
      setModeratingSubmissionId(null);
    }
  }

  async function openLabelEditor(detection: DetectionItem) {
    setEditDetection(detection);
    setFinalLabel(pendingRelabels[detection.id]?.finalLabel || detection.label);
    setLabelError("");
    try {
      setInventoryLabels(await getAllInventory());
    } catch {
      setInventoryLabels([]);
    }
  }

  async function saveRelabel() {
    const correctedLabel = finalLabel.trim();
    if (!editDetection || !selectedScan) return;
    if (!correctedLabel) {
      setLabelError("Enter a product label before saving.");
      return;
    }
    setSavingLabel(true);
    setLabelError("");
    try {
      const response = await createAnnotationSubmission(selectedScan.id, [{
        action: "RELABEL",
        source_detection_id: editDetection.id,
        final_label: correctedLabel,
      }]);
      setPendingRelabels((current) => ({
        ...current,
        [editDetection.id]: { finalLabel: correctedLabel, submissionId: response.submission.id },
      }));
      setSubmissionMessage(`${editDetection.label} → ${correctedLabel} was submitted for review.`);
      setEditDetection(null);
      await selectScan(selectedScan);
    } catch (caught) {
      setLabelError(caught instanceof Error ? caught.message : "Could not submit the corrected label.");
    } finally {
      setSavingLabel(false);
    }
  }

  async function confirmRemoveDetection() {
    if (!removeDetection || !selectedScan || removingDetectionId !== null || pendingRemovals[removeDetection.id]) return;
    const detection = removeDetection;
    setRemovingDetectionId(detection.id);
    setRemoveError("");
    try {
      const response = await createAnnotationSubmission(selectedScan.id, [{
        action: "REMOVE",
        source_detection_id: detection.id,
      }]);
      setPendingRemovals((current) => ({ ...current, [detection.id]: response.submission.id }));
      setSubmissionMessage(`${detection.label} was submitted as a false positive and is pending review.`);
      setRemoveDetection(null);
      await selectScan(selectedScan);
    } catch (caught) {
      setRemoveError(caught instanceof Error ? caught.message : "Could not submit the false-positive report.");
    } finally {
      setRemovingDetectionId(null);
    }
  }

  async function submitDetectionConfirmation() {
    if (!confirmDetection || !selectedScan || confirmingDetectionId !== null || pendingConfirms[confirmDetection.id] || pendingRelabels[confirmDetection.id] || pendingRemovals[confirmDetection.id] || pendingBoxes[confirmDetection.id]) return;
    const detection = confirmDetection;
    setConfirmingDetectionId(detection.id);
    setConfirmError("");
    try {
      const response = await createAnnotationSubmission(selectedScan.id, [{
        action: "CONFIRM",
        source_detection_id: detection.id,
      }]);
      setPendingConfirms((current) => ({ ...current, [detection.id]: response.submission.id }));
      setSubmissionMessage(`${detection.label} was confirmed and submitted for review.`);
      setConfirmDetection(null);
      await selectScan(selectedScan);
    } catch (caught) {
      setConfirmError(caught instanceof Error ? caught.message : "Could not confirm this detection.");
    } finally {
      setConfirmingDetectionId(null);
    }
  }

  async function openContributionEditor(contribution: Contribution) {
    setEditContribution(contribution);
    setContributionLabel(contribution.annotation.final_label || "");
    setContributionEditError("");
    try {
      setInventoryLabels(await getAllInventory());
    } catch {
      setInventoryLabels([]);
    }
  }

  async function saveContributionLabel() {
    const correctedLabel = contributionLabel.trim();
    if (!editContribution || editContribution.submission.status !== "pending" || !["RELABEL", "ADD"].includes(editContribution.annotation.action)) return;
    if (!correctedLabel) {
      setContributionEditError("Enter a product label before saving.");
      return;
    }
    setSavingContribution(true);
    setContributionEditError("");
    try {
      await updateAnnotationLabel(editContribution.annotation.id, correctedLabel);
      setEditContribution(null);
      setContributionMessage("Pending label correction updated successfully.");
      await loadContributions();
    } catch (caught) {
      setContributionEditError(caught instanceof Error ? caught.message : "Could not update the label correction.");
    } finally {
      setSavingContribution(false);
    }
  }

  function detectionBox(detection: DetectionItem): ImageBoundingBox | null {
    if (detection.x1 == null || detection.y1 == null || detection.x2 == null || detection.y2 == null) return null;
    if (detection.x2 <= detection.x1 || detection.y2 <= detection.y1) return null;
    return { x1: detection.x1, y1: detection.y1, x2: detection.x2, y2: detection.y2 };
  }

  function openSuggestionBoxEditor(detection: DetectionItem) {
    const originalBox = detectionBox(detection);
    if (!selectedScan || !originalBox) return;
    setBoxError("");
    setBoxEditor({
      source: "suggestion",
      scanId: selectedScan.id,
      imageWidth: selectedScan.image_width,
      imageHeight: selectedScan.image_height,
      detectionId: detection.id,
      label: detection.label,
      originalBox,
      box: originalBox,
    });
  }

  async function openAddBoxEditor() {
    if (!selectedScan) return;
    try {
      setSuggestionsError("");
      await openAddBoxEditorForScan(selectedScan);
    } catch (caught) {
      setSuggestionsError(caught instanceof Error ? caught.message : "Could not open the original scan image.");
    }
  }

  async function openAddBoxEditorForScan(scan: RecentScan) {
    if (!Number.isFinite(scan.image_width) || !Number.isFinite(scan.image_height) || scan.image_width <= 0 || scan.image_height <= 0) {
      throw new Error(`Scan #${scan.id} does not have valid image dimensions.`);
    }
    const imageUrl = getScanImageUrl(scan.id);
    await new Promise<void>((resolve, reject) => {
      Image.getSize(imageUrl, (width, height) => {
        if (width <= 0 || height <= 0) {
          reject(new Error(`Scan #${scan.id} image dimensions could not be read.`));
          return;
        }
        if (!areImageDimensionsCompatible(scan.image_width, scan.image_height, width, height)) {
          reject(new Error(`Scan #${scan.id} image geometry is incompatible: stored ${scan.image_width} × ${scan.image_height}, decoded ${width} × ${height}.`));
          return;
        }
        resolve();
      }, () => reject(new Error(`The original image for scan #${scan.id} could not be loaded.`)));
    });
    setBoxError("");
    setBoxEditor({
      source: "add",
      scanId: scan.id,
      imageWidth: scan.image_width,
      imageHeight: scan.image_height,
      label: "",
      originalBox: null,
      box: null,
    });
    try {
      setInventoryLabels(await getAllInventory());
    } catch {
      setInventoryLabels([]);
    }
  }

  function openContributionBoxEditor(contribution: Contribution) {
    const { annotation, submission } = contribution;
    if (submission.status !== "pending" || annotation.action !== "ADJUST_BOX" || annotation.source_detection_id == null) return;
    const originalValues = [annotation.original_x1, annotation.original_y1, annotation.original_x2, annotation.original_y2];
    const finalValues = [annotation.final_x1, annotation.final_y1, annotation.final_x2, annotation.final_y2];
    if (originalValues.some((value) => value == null) || finalValues.some((value) => value == null)) return;
    const originalBox = { x1: originalValues[0]!, y1: originalValues[1]!, x2: originalValues[2]!, y2: originalValues[3]! };
    const box = { x1: finalValues[0]!, y1: finalValues[1]!, x2: finalValues[2]!, y2: finalValues[3]! };
    setBoxError("");
    setBoxEditor({
      source: "contribution",
      scanId: submission.scan_id,
      imageWidth: submission.image_width,
      imageHeight: submission.image_height,
      detectionId: annotation.source_detection_id,
      annotationId: annotation.id,
      label: annotation.final_label || annotation.original_label || "Detection",
      originalBox,
      box,
    });
  }

  async function saveBoxCorrection() {
    if (!boxEditor) return;
    const { box } = boxEditor;
    if (!box) {
      setBoxError("Draw a bounding box around the missed product before saving.");
      return;
    }
    const label = boxEditor.label.trim();
    if (boxEditor.source === "add" && !label) {
      setBoxError("Choose or enter the product label before saving.");
      return;
    }
    if (box.x1 < 0 || box.y1 < 0 || box.x2 > boxEditor.imageWidth || box.y2 > boxEditor.imageHeight || box.x2 <= box.x1 || box.y2 <= box.y1) {
      setBoxError("The box must have a positive size and stay inside the image.");
      return;
    }
    const minimumSize = getMinimumAnnotationBoxSize(boxEditor.imageWidth, boxEditor.imageHeight);
    if (boxEditor.source === "add" && (box.x2 - box.x1 < minimumSize || box.y2 - box.y1 < minimumSize)) {
      setBoxError("The box is too small. Draw a clear box around the whole product.");
      return;
    }
    const savedBox = { x1: Number(box.x1.toFixed(2)), y1: Number(box.y1.toFixed(2)), x2: Number(box.x2.toFixed(2)), y2: Number(box.y2.toFixed(2)) };
    setSavingBox(true);
    setBoxError("");
    try {
      if (boxEditor.source === "suggestion") {
        if (boxEditor.detectionId == null) throw new Error("Source detection is missing.");
        const detectionId = boxEditor.detectionId;
        const response = await createAnnotationSubmission(boxEditor.scanId, [{
          action: "ADJUST_BOX",
          source_detection_id: detectionId,
          final_x1: savedBox.x1,
          final_y1: savedBox.y1,
          final_x2: savedBox.x2,
          final_y2: savedBox.y2,
        }]);
        setPendingBoxes((current) => ({ ...current, [detectionId]: response.submission.id }));
        setSubmissionMessage(`${boxEditor.label} box adjustment was submitted and is pending review.`);
      } else if (boxEditor.source === "add") {
        await createAnnotationSubmission(boxEditor.scanId, [{
          action: "ADD",
          source_detection_id: null,
          final_label: label,
          final_x1: savedBox.x1,
          final_y1: savedBox.y1,
          final_x2: savedBox.x2,
          final_y2: savedBox.y2,
        }]);
        setSubmissionMessage(`${label} was added as a missed product and is pending review.`);
      } else if (boxEditor.annotationId != null) {
        await updateAnnotationBox(boxEditor.annotationId, savedBox);
        setContributionMessage("Pending bounding-box correction updated successfully.");
        await loadContributions();
      }
      setBoxEditor(null);
    } catch (caught) {
      setBoxError(caught instanceof Error ? caught.message : "Could not save the bounding-box correction.");
    } finally {
      setSavingBox(false);
    }
  }

  const productLabelSuggestions = useMemo(() => uniqueProductLabels([
    ...inventoryLabels.map((item) => item.name),
    ...contributions.flatMap(({ annotation }) => [annotation.final_label, annotation.original_label]),
    ...(progressStats?.comparison?.class_comparison.active_classes || []),
    ...(progressStats?.comparison?.class_comparison.candidate_classes || []),
  ]), [contributions, inventoryLabels, progressStats]);
  const currentCandidate = progressStats?.candidate ?? progressStats?.latest_candidate ?? null;
  const activeDistinctiveClasses = progressStats
    ? progressStats.rollback_targets
      .map((target) => singleAddedClass(progressStats.active_model_classes.classes, target.supported_classes))
      .filter((name): name is string => Boolean(name))
    : [];
  const uniqueActiveDistinctiveClasses = [...new Map(activeDistinctiveClasses.map((name) => [name.toLocaleLowerCase(), name])).values()];
  const activeModelName = readableModelName(
    progressStats?.active_model,
    uniqueActiveDistinctiveClasses.length === 1 ? uniqueActiveDistinctiveClasses[0] : null,
  );
  const candidateModelName = readableModelName(
    currentCandidate,
    progressStats?.comparison?.class_comparison.added_classes.length === 1
      ? progressStats.comparison.class_comparison.added_classes[0]
      : null,
  );
  const rollbackTargetDisplayName = (target: RollbackTarget | null | undefined) => readableModelName(
    target,
    target && progressStats
      ? singleAddedClass(target.supported_classes, progressStats.active_model_classes.classes)
      : null,
  );
  const modelNamesByVersion = new Map<string, string>();
  if (progressStats) modelNamesByVersion.set(progressStats.active_model.version, activeModelName);
  if (currentCandidate) modelNamesByVersion.set(currentCandidate.version, candidateModelName);
  progressStats?.rollback_targets.forEach((target) => modelNamesByVersion.set(target.version, rollbackTargetDisplayName(target)));
  const displayNameForModel = (model: ModelIdentity | null | undefined) => {
    const knownName = model?.version ? modelNamesByVersion.get(model.version) : null;
    return knownName || readableModelName(model);
  };

  const visibleContributions = useMemo(() => {
    const query = contributionSearch.trim().toLocaleLowerCase();
    const labelFilter = contributionLabelFilter.trim().toLocaleLowerCase();
    return contributions
      .filter(({ annotation, submission }) => {
        const label = contributionProductLabel(annotation).toLocaleLowerCase();
        const latestUsage = annotation.training_usages?.[0] ?? submission.training_usages?.[0];
        const status = latestUsage ? "used" : submission.status;
        return (contributionFilter === "All" || status === contributionFilter.toLocaleLowerCase())
          && (!query || label.includes(query))
          && (!labelFilter || label === labelFilter);
      })
      .sort((left, right) => {
        if (contributionSort === "Product") {
          const byProduct = contributionProductLabel(left.annotation).localeCompare(contributionProductLabel(right.annotation));
          if (byProduct) return byProduct;
        }
        const byDate = new Date(right.annotation.created_at || right.submission.created_at).getTime()
          - new Date(left.annotation.created_at || left.submission.created_at).getTime();
        return contributionSort === "Oldest" ? -byDate : byDate;
      });
  }, [contributionFilter, contributionLabelFilter, contributionSearch, contributionSort, contributions]);

  const contributionGroups = useMemo(() => {
    if (contributionSort !== "Product") return [{ label: "", contributions: visibleContributions }];
    const groups = new Map<string, Contribution[]>();
    visibleContributions.forEach((contribution) => {
      const label = contributionProductLabel(contribution.annotation);
      groups.set(label, [...(groups.get(label) || []), contribution]);
    });
    return [...groups].map(([label, groupedContributions]) => ({ label, contributions: groupedContributions }));
  }, [contributionSort, visibleContributions]);

  const hasContributionFilters = contributionFilter !== "All" || Boolean(contributionSearch.trim()) || Boolean(contributionLabelFilter.trim()) || contributionSort !== "Newest";
  const selectedAnnotationCount = useMemo(
    () => eligibleSubmissions.reduce(
      (count, detail) => count + (selectedTrainingSubmissions.has(detail.submission.id) ? detail.annotations.length : 0),
      0,
    ),
    [eligibleSubmissions, selectedTrainingSubmissions],
  );
  const trainingLabelGroups = useMemo(() => {
    const groups = new Map<string, { label: string; submissions: AnnotationSubmissionDetail[] }>();
    eligibleSubmissions.forEach((detail) => {
      const labels = new Map<string, string>();
      detail.annotations.forEach((annotation) => {
        const label = contributionProductLabel(annotation);
        labels.set(label.toLocaleLowerCase(), label);
      });
      labels.forEach((label, key) => {
        const group = groups.get(key) || { label, submissions: [] };
        group.submissions.push(detail);
        groups.set(key, group);
      });
    });
    return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [eligibleSubmissions]);

  const quarantineLabelGroups = useMemo(() => {
    const groups = new Map<string, { label: string; submissions: AnnotationSubmissionDetail[] }>();
    quarantinedSubmissions.forEach((detail) => {
      const labels = new Map<string, string>();
      detail.annotations.forEach((annotation) => {
        const label = contributionProductLabel(annotation);
        labels.set(label.toLocaleLowerCase(), label);
      });
      labels.forEach((label, key) => {
        const group = groups.get(key) || { label, submissions: [] };
        group.submissions.push(detail);
        groups.set(key, group);
      });
    });
    return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [quarantinedSubmissions]);

  function toggleTrainingGroup(submissions: AnnotationSubmissionDetail[]) {
    const ids = submissions.map((detail) => detail.submission.id);
    const allSelected = ids.every((id) => selectedTrainingSubmissions.has(id));
    setSelectedTrainingSubmissions((current) => {
      const next = new Set(current);
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }

  function toggleQuarantineGroup(submissions: AnnotationSubmissionDetail[]) {
    const ids = [...new Set(submissions.map((detail) => detail.submission.id))];
    const allSelected = ids.length > 0 && ids.every((id) => selectedQuarantineSubmissions.has(id));
    setSelectedQuarantineSubmissions((current) => {
      const next = new Set(current);
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }

  async function restoreSelectedQuarantinedSubmissions() {
    const selectedIds = [...selectedQuarantineSubmissions].sort((left, right) => left - right);
    if (!selectedIds.length || quarantineMutation !== null) return;

    setQuarantineMutation(-1);
    setQuarantineError("");
    setQuarantineMessage("");
    try {
      for (const submissionId of selectedIds) {
        await manageQuarantinedSubmission(submissionId, "restore");
      }
      setSelectedQuarantineSubmissions(new Set());
      setQuarantineMessage(`${selectedIds.length} submission${selectedIds.length === 1 ? "" : "s"} restored and ready to select for training.`);
      await Promise.all([loadTrainingSelection(), loadProgress(), loadContributions()]);
    } catch (caught) {
      setQuarantineError(caught instanceof Error ? caught.message : "Could not restore the selected submissions.");
    } finally {
      setQuarantineMutation(null);
    }
  }

  function contributionDetection(contribution: Contribution): DetectionItem {
    const { annotation } = contribution;
    return {
      id: annotation.id,
      label: annotation.final_label || annotation.original_label || annotation.action,
      confidence: annotation.original_confidence || 0,
      x1: annotation.final_x1 ?? annotation.original_x1,
      y1: annotation.final_y1 ?? annotation.original_y1,
      x2: annotation.final_x2 ?? annotation.original_x2,
      y2: annotation.final_y2 ?? annotation.original_y2,
    };
  }

  function formatAnnotationBox(annotation: AnnotationItem, prefix: "original" | "final") {
    const values = prefix === "original"
      ? [annotation.original_x1, annotation.original_y1, annotation.original_x2, annotation.original_y2]
      : [annotation.final_x1, annotation.final_y1, annotation.final_x2, annotation.final_y2];
    if (values.some((value) => value == null)) return "None";
    return values.map((value) => Math.round(value!)).join(", ");
  }

  function renderContributionCard(contribution: Contribution) {
    const { annotation, submission } = contribution;
    const latestUsage = annotation.training_usages?.[0] ?? submission.training_usages?.[0];
    const displayedStatus = latestUsage ? "used" : submission.status;
    const lifecycleState = trainingState(submission);
    const lifecycleCopy = trainingStateCopy(lifecycleState);
    const canEdit = submission.status === "pending" && ["RELABEL", "ADD"].includes(annotation.action);
    const canEditBox = submission.status === "pending" && annotation.action === "ADJUST_BOX";
    return (
      <Card>
        <View style={styles.contributionHeader}>
          <View style={[styles.detectionIcon, annotation.action === "REMOVE" && styles.removeIcon]}><Ionicons name={annotation.action === "REMOVE" ? "trash-outline" : "create-outline"} size={22} color={annotation.action === "REMOVE" ? colors.danger : colors.primary} /></View>
          <View style={styles.detectionCopy}>
            <Text style={styles.contributionProduct}>{contributionProductLabel(annotation)}</Text>
            <Text style={styles.contributionAction}>{actionTitle(annotation.action)} · Scan #{submission.scan_id}</Text>
            <Text style={styles.detectionMeta}>{new Date(submission.created_at).toLocaleString("en-GB")}</Text>
          </View>
          <StatusBadge label={contributionStatus(displayedStatus, Boolean(latestUsage))} tone={statusTone(displayedStatus)} />
        </View>
        <View style={styles.changeStory}>
          <View style={styles.storyStep}><Text style={styles.detailCaption}>MODEL</Text><Text style={styles.storyValue}>{annotation.original_label || "No product"}</Text></View>
          <Ionicons name="arrow-forward" size={17} color={colors.textMuted} />
          <View style={styles.storyStep}><Text style={styles.detailCaption}>YOU</Text><Text style={styles.storyValue}>{contributionChange(annotation)}</Text></View>
        </View>
        {submission.status === "approved" || submission.status === "used" ? <View style={styles.lifecycleStateRow}><StatusBadge label={lifecycleCopy.label} tone={lifecycleCopy.tone} /><Text style={styles.lifecycleStateText}>{lifecycleCopy.explanation}</Text></View> : null}
        <View style={styles.detectionActions}>
          <View style={styles.detectionAction}><AppButton label="View image" icon="image-outline" variant="secondary" onPress={() => setContributionImage(contribution)} /></View>
          {canEdit ? <View style={styles.detectionAction}><AppButton label="Edit label" icon="create-outline" variant="ghost" onPress={() => openContributionEditor(contribution)} /></View> : null}
          {canEditBox ? <View style={styles.detectionAction}><AppButton label="Edit box" icon="crop-outline" variant="ghost" onPress={() => openContributionBoxEditor(contribution)} /></View> : null}
        </View>
        {latestUsage ? <View style={styles.usedModelBox}><Ionicons name="sparkles" size={20} color={colors.successFg} /><View style={styles.detectionCopy}><Text style={styles.usedModelTitle}>Used in model {latestUsage.model_version}</Text><Text style={styles.usedModelMeta}>Used for training · This contribution is read-only.</Text></View></View> : null}
        {!latestUsage && submission.status === "used" ? <Text style={styles.readOnlyText}>Used for AI learning · Read-only</Text> : null}
      </Card>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <ScreenHeader
        eyebrow="Help the fridge learn"
        title="Teach AI"
        subtitle="Correct a prediction, add a missed product, or follow improvements."
      />

      <View accessibilityRole="tablist" style={styles.tabs}>
        {TABS.map((tab) => {
          const selected = activeTab === tab;
          return (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setActiveTab(tab)}
              style={[styles.tab, selected && styles.activeTab]}
            >
              <Text style={[styles.tabText, selected && styles.activeTabText]}>{tab}</Text>
            </Pressable>
          );
        })}
      </View>

      {activeTab === "Suggestions" ? (
        <View style={styles.suggestions}>
          <Card>
            <View style={styles.manualAnnotationCallout}>
              <View style={styles.manualAnnotationIcon}><Ionicons name="create-outline" size={24} color={colors.primary} /></View>
              <View style={styles.detectionCopy}>
                <Text style={styles.manualAnnotationTitle}>Annotate a new image</Text>
                <Text style={styles.sectionSubtitle}>Upload an image and label products yourself. No AI scan required.</Text>
              </View>
              <AppButton label="Start" icon="arrow-forward" onPress={() => router.push("/manual-annotation" as never)} />
            </View>
          </Card>
          <View style={styles.sectionHeading}>
            <View><Text style={styles.sectionTitle}>What did the AI get wrong?</Text><Text style={styles.sectionSubtitle}>Choose the product and tell us the correct answer.</Text></View>
            <Pressable accessibilityRole="button" onPress={loadSuggestions} hitSlop={8}><Ionicons name="refresh" size={21} color={colors.primary} /></Pressable>
          </View>

          {loadingScans ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading recent scans...</Text></View> : null}
          {!loadingScans && scans.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scanList}>
              {scans.map((scan) => {
                const selected = selectedScan?.id === scan.id;
                return <Pressable key={scan.id} accessibilityRole="button" onPress={() => selectScan(scan)} style={[styles.scanChip, selected && styles.selectedScanChip]}>
                  <Text style={[styles.scanChipTitle, selected && styles.selectedScanText]}>Scan #{scan.id}</Text>
                  <Text style={[styles.scanChipMeta, selected && styles.selectedScanText]}>{new Date(scan.created_at).toLocaleDateString("en-GB")}</Text>
                  <Text style={[styles.scanChipMeta, selected && styles.selectedScanText]}>{scan.detection_count} detection{Number(scan.detection_count) === 1 ? "" : "s"}</Text>
                </Pressable>;
              })}
            </ScrollView>
          ) : null}
          {selectedScan ? <AppButton label="Add Missed Product" icon="add-circle-outline" variant="secondary" onPress={openAddBoxEditor} /> : null}

          {hasTargetedDetection && selectedScan?.id === requestedScanId ? (
            <View style={styles.targetedHelp}>
              <Ionicons name="sparkles-outline" size={20} color={colors.primary} />
              <View style={styles.detectionCopy}><Text style={styles.targetedHelpTitle}>Selected from Review</Text><Text style={styles.targetedHelpText}>This prediction was marked “Not included”. Choose the correction below.</Text></View>
            </View>
          ) : null}

          {suggestionsError ? <View style={styles.errorBox}><Text style={styles.errorText}>{suggestionsError}</Text><AppButton label="Try Again" variant="secondary" onPress={loadSuggestions} /></View> : null}
          {submissionMessage ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><View style={styles.detectionCopy}><Text style={styles.successText}>{submissionMessage}</Text><Pressable onPress={() => setActiveTab("Contributions")}><Text style={styles.successLink}>View contribution →</Text></Pressable></View></View> : null}
          {!loadingScans && !suggestionsError && scans.length === 0 ? <Card><EmptyState icon="camera-outline" title="No recent scans" message="Run a product scan first, then return here to view its suggestions." /></Card> : null}
          {loadingDetections ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading detections...</Text></View> : null}

          {!loadingDetections && selectedScan && detections.length === 0 && !suggestionsError ? (
            <Card><EmptyState icon="search-outline" title="No detections in this scan" message={`Scan #${selectedScan.id} was saved without any supported product detections.`} /></Card>
          ) : null}

          {!loadingDetections && detections.map((detection) => (
            <View key={detection.id} style={hasTargetedDetection && detection.id === requestedDetectionId ? styles.targetedDetection : undefined}>
            <Card>
              <View style={styles.detectionTop}>
                <View style={styles.detectionIcon}><Ionicons name="cube-outline" size={22} color={colors.primary} /></View>
                <View style={styles.detectionCopy}>
                  <Text style={styles.modelRole}>{detection.id === requestedDetectionId ? "SELECTED PREDICTION" : "AI PREDICTION"}</Text>
                  <Text style={styles.detectionLabel}>{detection.label}</Text>
                  <Text style={styles.detectionMeta}>Scan #{selectedScan?.id} · {selectedScan ? new Date(selectedScan.created_at).toLocaleString("en-GB") : ""}</Text>
                </View>
                <StatusBadge label={`${Math.round(detection.confidence * 100)}% CONFIDENT`} tone="info" />
              </View>
              {pendingRelabels[detection.id] ? (
                <View style={styles.pendingRow}>
                  <StatusBadge label="Pending" tone="warning" />
                  <Text style={styles.pendingText}>Suggested label: {pendingRelabels[detection.id].finalLabel}</Text>
                </View>
              ) : null}
              {pendingRemovals[detection.id] ? (
                <View style={styles.falsePositiveRow}>
                  <StatusBadge label="Pending" tone="danger" />
                  <Text style={styles.falsePositiveText}>Submitted as a false-positive detection.</Text>
                </View>
              ) : null}
              {pendingBoxes[detection.id] ? (
                <View style={styles.pendingRow}>
                  <StatusBadge label="Pending" tone="warning" />
                  <Text style={styles.pendingText}>Bounding-box correction submitted for review.</Text>
                </View>
              ) : null}
              {pendingConfirms[detection.id] ? (
                <View style={styles.confirmedRow}>
                  <StatusBadge label="Submitted" tone="success" />
                  <Text style={styles.confirmedText}>Detection marked as correct and pending review.</Text>
                </View>
              ) : null}
              <View style={styles.detectionActions}>
                <View style={styles.detectionAction}><AppButton label="Correct label" icon="create-outline" variant="secondary" disabled={Boolean(pendingConfirms[detection.id])} onPress={() => openLabelEditor(detection)} /></View>
                <View style={styles.detectionAction}><AppButton label={pendingRemovals[detection.id] ? "Submitted" : "Wrong detection"} icon={pendingRemovals[detection.id] ? "time-outline" : "trash-outline"} variant="danger" disabled={Boolean(pendingRemovals[detection.id]) || Boolean(pendingConfirms[detection.id])} onPress={() => { setRemoveError(""); setRemoveDetection(detection); }} /></View>
              </View>
              <View style={styles.detectionActionsSecondary}>
                <View style={styles.detectionAction}><AppButton label="View photo" icon="image-outline" variant="ghost" onPress={() => setImageDetection(detection)} /></View>
                <View style={styles.detectionAction}><AppButton label={pendingBoxes[detection.id] ? "Area submitted" : "Adjust area"} icon="crop-outline" variant="ghost" disabled={!detectionBox(detection) || Boolean(pendingBoxes[detection.id]) || Boolean(pendingConfirms[detection.id])} onPress={() => openSuggestionBoxEditor(detection)} /></View>
              </View>
              <View style={styles.confirmAction}>
                <AppButton label={pendingConfirms[detection.id] ? "Submitted as correct" : "The AI was correct"} icon={pendingConfirms[detection.id] ? "checkmark-circle" : "checkmark-circle-outline"} disabled={Boolean(pendingConfirms[detection.id] || pendingRelabels[detection.id] || pendingRemovals[detection.id] || pendingBoxes[detection.id])} onPress={() => { setConfirmError(""); setConfirmDetection(detection); }} />
              </View>
            </Card>
            </View>
          ))}
        </View>
      ) : activeTab === "Contributions" ? (
        <View style={styles.suggestions}>
          <View style={styles.sectionHeading}>
            <View><Text style={styles.sectionTitle}>Contribution history</Text><Text style={styles.sectionSubtitle}>See what the AI predicted, what you changed, and what happened next.</Text></View>
            <Pressable accessibilityRole="button" onPress={loadContributions} hitSlop={8}><Ionicons name="refresh" size={21} color={colors.primary} /></Pressable>
          </View>

          <Card>
            <TextInput
              value={contributionSearch}
              onChangeText={setContributionSearch}
              placeholder="Search by product label"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Search contributions by product label"
              autoCapitalize="words"
              returnKeyType="search"
              style={styles.searchInput}
            />
            <ProductLabelInput
              value={contributionLabelFilter}
              onChangeText={setContributionLabelFilter}
              suggestions={productLabelSuggestions}
              placeholder="Filter by exact product"
              accessibilityLabel="Filter contributions by exact product label"
            />
            <View>
              <Text style={styles.filterCaption}>STATUS</Text>
              <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
                {CONTRIBUTION_FILTERS.map((filter) => {
                  const selected = contributionFilter === filter;
                  return <Pressable key={filter} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Show ${filter.toLowerCase()} contributions`} onPress={() => setContributionFilter(filter)} style={[styles.filterChip, selected && styles.selectedFilterChip]}>
                    <Text style={[styles.filterText, selected && styles.selectedFilterText]}>{filter}</Text>
                  </Pressable>;
                })}
              </ScrollView>
            </View>
            <View>
              <Text style={styles.filterCaption}>SORT</Text>
              <View style={styles.sortOptions}>
                {(["Newest", "Oldest", "Product"] as ContributionSort[]).map((sort) => {
                  const selected = contributionSort === sort;
                  return <Pressable key={sort} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Sort contributions by ${sort.toLowerCase()}`} onPress={() => setContributionSort(sort)} style={[styles.filterChip, styles.sortChip, selected && styles.selectedFilterChip]}>
                    <Text style={[styles.filterText, selected && styles.selectedFilterText]}>{sort}</Text>
                  </Pressable>;
                })}
              </View>
            </View>
            {hasContributionFilters ? <AppButton label="Clear filters" icon="close-circle-outline" variant="ghost" onPress={() => { setContributionSearch(""); setContributionLabelFilter(""); setContributionFilter("All"); setContributionSort("Newest"); }} /> : null}
          </Card>

          {contributionMessage ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{contributionMessage}</Text></View> : null}
          {loadingContributions ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading contributions...</Text></View> : null}
          {contributionsError ? <View style={styles.errorBox}><Text style={styles.errorText}>{contributionsError}</Text><AppButton label="Try Again" variant="secondary" onPress={loadContributions} /></View> : null}
          {!loadingContributions && !contributionsError && visibleContributions.length === 0 ? <Card><EmptyState
            icon="search-outline"
            title={contributionSearch.trim() ? `No labels match “${contributionSearch.trim()}”` : contributionLabelFilter.trim() ? `No ${contributionLabelFilter.trim()} contributions` : "No contributions found"}
            message={contributionFilter === "All" ? "Try another product label or clear the current filters." : `There are no ${contributionFilter.toLowerCase()} contributions matching these filters.`}
            action={hasContributionFilters ? "Clear filters" : undefined}
            onAction={hasContributionFilters ? () => { setContributionSearch(""); setContributionLabelFilter(""); setContributionFilter("All"); setContributionSort("Newest"); } : undefined}
          /></Card> : null}

          {!loadingContributions && contributionGroups.map((group) => (
            <View key={group.label || "all-contributions"} style={styles.contributionGroup}>
              {contributionSort === "Product" ? <View style={styles.groupHeading}><Text style={styles.groupTitle}>{group.label}</Text><Text style={styles.groupCount}>{group.contributions.length} contribution{group.contributions.length === 1 ? "" : "s"}</Text></View> : null}
              {group.contributions.map((contribution) => <View key={contribution.annotation.id}>{renderContributionCard(contribution)}</View>)}
            </View>
          ))}

          <View style={styles.moderationDivider}>
            <View style={styles.detectionCopy}><View style={styles.queueTitleRow}><Text style={styles.sectionTitle}>Review queue</Text><StatusBadge label={`${moderationSubmissions.length} PENDING`} tone={moderationSubmissions.length ? "warning" : "neutral"} /></View><Text style={styles.sectionSubtitle}>Approve feedback before it can become training data. Decisions apply to the whole submission.</Text></View>
            <Pressable accessibilityRole="button" onPress={loadModeration} hitSlop={8}><Ionicons name="refresh" size={21} color={colors.primary} /></Pressable>
          </View>
          {moderationMessage ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{moderationMessage}</Text></View> : null}
          {loadingModeration ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading pending submissions...</Text></View> : null}
          {moderationError ? <View style={styles.errorBox}><Text style={styles.errorText}>{moderationError}</Text><AppButton label="Try Again" variant="secondary" onPress={loadModeration} /></View> : null}
          {!loadingModeration && !moderationError && moderationSubmissions.length === 0 ? <Card><EmptyState icon="shield-checkmark-outline" title="Moderation queue is clear" message="There are no pending annotation submissions to review." /></Card> : null}

          {!loadingModeration && moderationSubmissions.map((detail) => (
            <Card key={detail.submission.id}>
              <View style={styles.moderationHeader}>
                <View style={styles.detectionCopy}><Text style={styles.detectionLabel}>{detail.annotations[0] ? contributionProductLabel(detail.annotations[0]) : "Unlabeled product"}{detail.annotations.length > 1 ? ` +${detail.annotations.length - 1} more` : ""}</Text><Text style={styles.contributionAction}>{detail.annotations.map((annotation) => actionTitle(annotation.action)).join(" · ")}</Text><Text style={styles.detectionMeta}>Scan #{detail.submission.scan_id} · {new Date(detail.submission.created_at).toLocaleString("en-GB")}</Text></View>
                <StatusBadge label="PENDING" tone="warning" />
              </View>
              <DetectionImageViewer
                imageUri={getScanImageUrl(detail.submission.scan_id)}
                imageWidth={detail.submission.image_width}
                imageHeight={detail.submission.image_height}
                detections={detail.annotations.map((annotation) => contributionDetection({ submission: detail.submission, annotation }))}
                style={styles.moderationImage}
              />
              <View style={styles.moderationAnnotations}>
                {detail.annotations.map((annotation) => (
                  <View key={annotation.id} style={styles.moderationAnnotation}>
                    <View style={styles.annotationTitleRow}><View style={styles.detectionCopy}><Text style={styles.annotationTitle}>{contributionProductLabel(annotation)}</Text><Text style={styles.annotationDetail}>{actionTitle(annotation.action)}</Text></View></View>
                    {annotation.original_label && annotation.final_label && annotation.original_label.toLocaleLowerCase() !== annotation.final_label.toLocaleLowerCase() ? <Text style={styles.annotationDetail}>{annotation.original_label} → <Text style={styles.annotationValue}>{annotation.final_label}</Text></Text> : null}
                    <Pressable accessibilityRole="button" accessibilityState={{ expanded: moderationDetails.has(annotation.id) }} accessibilityLabel={`${moderationDetails.has(annotation.id) ? "Hide" : "Show"} annotation details for ${contributionProductLabel(annotation)}`} onPress={() => setModerationDetails((current) => { const next = new Set(current); if (next.has(annotation.id)) next.delete(annotation.id); else next.add(annotation.id); return next; })} style={styles.detailsToggle}>
                      <Text style={styles.detailsToggleText}>{moderationDetails.has(annotation.id) ? "Hide details" : "Details"}</Text><Ionicons name={moderationDetails.has(annotation.id) ? "chevron-up" : "chevron-down"} size={16} color={colors.primary} />
                    </Pressable>
                    {moderationDetails.has(annotation.id) ? <View style={styles.coordinateDetails}><Text style={styles.annotationDetail}>Original box: <Text style={styles.annotationValue}>{formatAnnotationBox(annotation, "original")}</Text></Text><Text style={styles.annotationDetail}>Final box: <Text style={styles.annotationValue}>{formatAnnotationBox(annotation, "final")}</Text></Text></View> : null}
                  </View>
                ))}
              </View>
              <View style={styles.moderationActions}>
                <View style={styles.detectionAction}><AppButton label="Reject" icon="close-circle-outline" variant="danger" disabled={moderatingSubmissionId !== null} loading={moderatingSubmissionId === detail.submission.id} onPress={() => moderateSubmission(detail.submission.id, "rejected")} /></View>
                <View style={styles.detectionAction}><AppButton label="Approve" icon="checkmark-circle-outline" disabled={moderatingSubmissionId !== null} loading={moderatingSubmissionId === detail.submission.id} onPress={() => moderateSubmission(detail.submission.id, "approved")} /></View>
              </View>
            </Card>
          ))}
        </View>
      ) : (
        <View style={styles.suggestions}>
          <View style={styles.sectionHeading}>
            <View><Text style={styles.sectionTitle}>AI Progress</Text><Text style={styles.sectionSubtitle}>Model status, training history, and product support.</Text></View>
            <Pressable accessibilityRole="button" onPress={() => { loadProgress(); loadTrainingSelection(); }} hitSlop={8}><Ionicons name="refresh" size={21} color={colors.primary} /></Pressable>
          </View>
          {loadingProgress ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading model progress...</Text></View> : null}
          {progressError ? <View style={styles.errorBox}><Text style={styles.errorText}>{progressError}</Text><AppButton label="Try Again" variant="secondary" onPress={loadProgress} /></View> : null}
          {!loadingProgress && progressStats ? <>
            <Card>
              <View style={styles.modelCardHeader}>
                <View style={styles.detectionCopy}>
                  <Text style={styles.modelRole}>ACTIVE MODEL</Text>
                  <Text style={styles.modelDisplayName}>{activeModelName}</Text>
                </View>
                <StatusBadge label="IN USE" tone="success" />
              </View>

              {lifecycle.job && (lifecycle.job.status === "queued" || lifecycle.job.status === "running") ? <View style={styles.jobStatus}><ActivityIndicator color={colors.primary} /><View style={styles.detectionCopy}><Text style={styles.jobTitle}>{lifecycle.action || (lifecycle.job.kind === "TRAIN" ? "Training new model" : "Comparing models")}</Text><Text style={styles.jobMeta}>{lifecyclePhaseLabel(lifecycle.job)}</Text></View></View> : null}

              {currentCandidate ? <>
                <View style={styles.compactDivider} />
                <View style={styles.candidateCompactRow}>
                  <View style={styles.detectionCopy}>
                    <Text style={styles.modelRole}>CANDIDATE</Text>
                    <Text style={styles.modelDisplayName}>{candidateModelName}</Text>
                  </View>
                  <StatusBadge
                    label={candidateStateCopy(progressStats.candidate_state).label}
                    tone={candidateStateCopy(progressStats.candidate_state).tone}
                  />
                </View>
                <Text style={styles.actionHint}>{candidateStateCopy(progressStats.candidate_state).description}</Text>

                {progressStats.comparison && !progressStats.promotion_evaluation.stale ? <View style={styles.comparisonCompact}>
                  <View style={styles.comparisonCompactHeader}>
                    <View style={styles.detectionCopy}>
                      <Text style={styles.comparisonCompactTitle}>{activeModelName} vs {candidateModelName}</Text>
                      <Text style={styles.comparisonCompactText}>{progressStats.promotion_evaluation.eligible
                        ? "Candidate passed the promotion policy."
                        : progressStats.promotion_evaluation.stale
                          ? "Comparison is stale. Run it again before deciding this candidate."
                          : progressStats.promotion_evaluation.reasons.some((reason) => ["comparison_missing", "missing_shared_classes", "malformed_class_metrics"].includes(reason.code))
                            ? "Comparison is incomplete or invalid. Retry it before deciding this candidate."
                            : "Candidate did not meet the promotion policy."}</Text>
                    </View>
                    <StatusBadge
                      label={progressStats.promotion_evaluation.eligible
                        ? "PASS"
                        : progressStats.promotion_evaluation.stale || progressStats.promotion_evaluation.reasons.some((reason) => ["comparison_missing", "missing_shared_classes", "malformed_class_metrics"].includes(reason.code))
                          ? "INVALID"
                          : "FAIL"}
                      tone={progressStats.promotion_evaluation.eligible ? "success" : "warning"}
                    />
                  </View>
                  <View style={styles.metricSummaryRow}>
                    <View style={styles.metricSummaryItem}><Text style={styles.metricSummaryLabel}>{activeModelName.toLocaleUpperCase()} mAP50–95</Text><Text style={styles.metricSummaryValue}>{formatMetric(progressStats.comparison.active_metrics.map50_95)}</Text></View>
                    <View style={styles.metricSummaryItem}><Text style={styles.metricSummaryLabel}>{candidateModelName.toLocaleUpperCase()}</Text><Text style={styles.metricSummaryValue}>{formatMetric(progressStats.comparison.candidate_metrics.map50_95)}</Text></View>
                    <View style={styles.metricSummaryItem}><Text style={styles.metricSummaryLabel}>CHANGE</Text><Text style={[styles.metricSummaryValue, (progressStats.comparison.metric_differences.map50_95 ?? 0) > 0 ? styles.positiveDelta : (progressStats.comparison.metric_differences.map50_95 ?? 0) < 0 ? styles.negativeDelta : null]}>{formatMetricDifference(progressStats.comparison.metric_differences.map50_95)}</Text></View>
                  </View>
                  <Pressable accessibilityRole="button" accessibilityState={{ expanded: showModelDetails }} onPress={() => setShowModelDetails((shown) => !shown)} style={styles.comparisonDetailsToggle}><Text style={styles.comparisonDetailsText}>{showModelDetails ? "Hide comparison details" : "View comparison details"}</Text><Ionicons name={showModelDetails ? "chevron-up" : "chevron-down"} size={16} color={colors.primary} /></Pressable>
                  {showModelDetails ? <View style={styles.comparisonDetails}>
                    {progressStats.promotion_evaluation.reasons.length ? <View style={[styles.readinessBox, progressStats.promotion_evaluation.eligible ? styles.readinessReady : styles.readinessBlocked]}><Ionicons name={progressStats.promotion_evaluation.eligible ? "checkmark-circle" : "alert-circle"} size={20} color={progressStats.promotion_evaluation.eligible ? colors.successFg : colors.warningFg} /><View style={styles.detectionCopy}>{progressStats.promotion_evaluation.reasons.map((reason, index) => <Text key={`${reason.code}-${index}`} style={styles.readinessReason}>• {promotionReasonText(reason)}</Text>)}</View></View> : null}
                    <View style={styles.metricCards}>
                      {METRIC_ROWS.map(({ key, label }) => {
                        const difference = progressStats.comparison?.metric_differences[key];
                        return <View key={key} style={styles.metricCard}><View style={styles.metricCardHeading}><Text style={styles.metricCardName}>{label}</Text><Text style={[styles.metricVerdict, difference != null && difference > 0 ? styles.positiveDelta : difference != null && difference < 0 ? styles.negativeDelta : null]}>{metricVerdict(difference)}</Text></View><View style={styles.metricValues}><View><Text style={styles.metricValueLabel}>{activeModelName.toLocaleUpperCase()}</Text><Text style={styles.metricValue}>{formatMetric(progressStats.comparison?.active_metrics[key])}</Text></View><View><Text style={styles.metricValueLabel}>{candidateModelName.toLocaleUpperCase()}</Text><Text style={styles.metricValue}>{formatMetric(progressStats.comparison?.candidate_metrics[key])}</Text></View><Text style={[styles.metricCardDelta, difference != null && difference > 0 ? styles.positiveDelta : difference != null && difference < 0 ? styles.negativeDelta : null]}>{formatMetricDifference(difference)}</Text></View></View>;
                      })}
                    </View>
                    {progressStats.promotion_evaluation.mode === "expanded_classes" ? <View style={styles.sharedComparison}><Text style={styles.sectionTitle}>Added products ({progressStats.comparison.class_comparison.added_classes.length})</Text><View style={styles.classList}>{progressStats.comparison.class_comparison.added_classes.map((name) => <View key={name} style={styles.classRow}><Text style={styles.className}>{name}</Text><Text style={styles.classMetric}>mAP50–95 {formatMetric(progressStats.comparison!.added_class_metrics.per_class[name]?.map50_95)}</Text></View>)}</View></View> : null}
                  </View> : null}
                </View> : null}
              </> : <View style={styles.lifecycleEmpty}><Ionicons name="flask-outline" size={19} color={colors.textMuted} /><Text style={styles.lifecycleEmptyText}>No candidate currently under evaluation.</Text></View>}

              {lifecycle.message || mutationMessage ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{mutationMessage || lifecycle.message}</Text></View> : null}
              {lifecycle.error || mutationError ? <View style={styles.errorBox}><Text style={styles.errorText}>{mutationError || lifecycle.error}</Text></View> : null}
            </Card>

            <View style={styles.primaryLifecycleAction}>
              {currentCandidate && ["needs_comparison", "comparison_stale", "comparison_invalid"].includes(progressStats.candidate_state) ? <AppButton label={progressStats.candidate_state === "needs_comparison" ? "Compare Candidate" : "Retry Comparison"} icon="analytics-outline" loading={lifecycle.action === "Compare Models"} disabled={lifecycle.busy || Boolean(lifecycleMutation) || !progressStats.actions.can_compare} onPress={() => lifecycle.runJob("Compare Models", () => startCandidateComparison(currentCandidate.version))} /> : null}
              {currentCandidate && progressStats.comparison && ["not_eligible", "eligible"].includes(progressStats.candidate_state) ? <AppButton label="View Comparison" icon="stats-chart-outline" variant="secondary" onPress={() => setShowModelDetails(true)} /> : null}
              {currentCandidate && progressStats.candidate_state === "eligible" ? <AppButton label="Promote Candidate" icon="rocket-outline" loading={lifecycleMutation === "Promote Candidate"} disabled={lifecycle.busy || Boolean(lifecycleMutation) || !progressStats.actions.can_promote} onPress={confirmPromotion} /> : null}
              {currentCandidate ? <AppButton label="Reject Candidate" icon="close-circle-outline" variant="danger" loading={lifecycleMutation === "Reject Candidate"} disabled={lifecycle.busy || Boolean(lifecycleMutation)} onPress={confirmCandidateRejection} /> : null}
              {!currentCandidate ? <AppButton label="Train a candidate" icon="school-outline" disabled={lifecycle.busy || Boolean(lifecycleMutation) || eligibleSubmissions.length === 0} onPress={() => setShowTrainingSelector(true)} /> : null}
              {progressStats.actions.can_rollback ? <AppButton label="Rollback Model" icon="arrow-undo-outline" variant="secondary" onPress={openRollbackSelector} /> : null}
              {currentCandidate ? <Text style={styles.actionHint}>Resolve the current candidate before starting another training run. Quarantine remains available below.</Text> : eligibleSubmissions.length === 0 ? <Text style={styles.actionHint}>Restore or approve a submission to train.</Text> : null}
            </View>

            <View style={styles.quickActions}>
              <Pressable accessibilityRole="button" onPress={() => setShowTrainingHistory(true)} style={styles.quickAction}>
                <View style={styles.quickActionIcon}><Ionicons name="time-outline" size={20} color={colors.primary} /></View>
                <View style={styles.detectionCopy}><Text style={styles.quickActionTitle}>Training History</Text><Text style={styles.quickActionMeta}>{progressStats.training_history.length} recent runs</Text></View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => openQuarantine(false)} style={[styles.quickAction, quarantinedSubmissions.length > 0 && styles.quickActionDanger]}>
                <View style={[styles.quickActionIcon, quarantinedSubmissions.length > 0 && styles.quickActionIconDanger]}><Ionicons name="archive-outline" size={20} color={quarantinedSubmissions.length > 0 ? colors.danger : colors.textMuted} /></View>
                <View style={styles.detectionCopy}><Text style={[styles.quickActionTitle, quarantinedSubmissions.length > 0 && styles.quickActionTitleDanger]}>Quarantine</Text><Text style={styles.quickActionMeta}>{quarantinedSubmissions.length} submission{quarantinedSubmissions.length === 1 ? "" : "s"}</Text></View>
                <Ionicons name="chevron-forward" size={18} color={quarantinedSubmissions.length > 0 ? colors.danger : colors.textMuted} />
              </Pressable>
            </View>

            <Card>
              <View style={styles.sectionHeading}><View><Text style={styles.sectionTitle}>Active Model Products</Text><Text style={styles.sectionSubtitle}>{progressStats.active_model_classes.available ? `${progressStats.active_model_classes.count} supported products` : "Product support metadata unavailable"}</Text></View><Ionicons name="pricetags-outline" size={22} color={colors.primary} /></View>
              {progressStats.active_model_classes.available ? <View style={styles.classChips}>{progressStats.active_model_classes.classes.map((name) => <View key={name} style={styles.classChip}><Text style={styles.classChipText}>{name}</Text></View>)}</View> : <Text style={styles.actionHint}>Product-class metadata is unavailable for this model.</Text>}
            </Card>
          </> : null}
        </View>
      )}

      {activeTab !== "AI Progress" ? <View style={styles.note}>
        <Ionicons name="information-circle-outline" size={19} color={colors.infoFg} />
        <Text style={styles.noteText}>Contributions are stored separately for review. Original YOLO detections remain unchanged.</Text>
      </View> : null}

      <Modal visible={showTrainingSelector} transparent animationType="slide" statusBarTranslucent onRequestClose={() => setShowTrainingSelector(false)}>
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.imageHeader}><View><Text style={styles.imageTitle}>Select training data</Text><Text style={styles.imageSubtitle}>{selectedTrainingSubmissions.size} submissions · {selectedAnnotationCount} annotations selected</Text></View><Pressable accessibilityLabel="Close training selection" onPress={() => setShowTrainingSelector(false)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable></View>
            <View style={styles.selectionControls}><Text style={styles.selectionAvailable}>{eligibleSubmissions.length} eligible submissions</Text><View style={styles.selectionControlButtons}><Pressable accessibilityRole="button" onPress={() => setSelectedTrainingSubmissions(new Set(eligibleSubmissions.map((detail) => detail.submission.id)))} style={styles.selectionControl}><Text style={styles.selectionControlText}>Select all</Text></Pressable><Pressable accessibilityRole="button" disabled={selectedTrainingSubmissions.size === 0} onPress={() => setSelectedTrainingSubmissions(new Set())} style={styles.selectionControl}><Text style={[styles.selectionControlText, selectedTrainingSubmissions.size === 0 && styles.selectionControlDisabled]}>Clear</Text></Pressable></View></View>
            <Text style={styles.sheetHelper}>Select whole submissions. Trusted data is included automatically.</Text>
            {quarantinedSubmissions.length ? <Pressable accessibilityRole="button" onPress={openQuarantineFromTraining} style={styles.sheetQuarantineLink}><Ionicons name="archive-outline" size={18} color={colors.danger} /><Text style={styles.sheetQuarantineText}>Manage Quarantine ({quarantinedSubmissions.length})</Text><Ionicons name="chevron-forward" size={17} color={colors.danger} /></Pressable> : null}
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
              {loadingTrainingSelection ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading annotations...</Text></View> : null}
              {trainingSelectionError ? <View style={styles.errorBox}><Text style={styles.errorText}>{trainingSelectionError}</Text><AppButton label="Try Again" variant="secondary" onPress={loadTrainingSelection} /></View> : null}
              {!loadingTrainingSelection && !trainingSelectionError && trainingLabelGroups.length === 0 ? <EmptyState icon="checkmark-done-outline" title="Nothing ready to train" message="Approve a contribution first." /> : null}
              {trainingLabelGroups.map((group) => {
                const ids = group.submissions.map((detail) => detail.submission.id);
                const selectedCount = ids.filter((id) => selectedTrainingSubmissions.has(id)).length;
                const expanded = expandedTrainingLabel === group.label;
                return <View key={group.label} style={styles.trainingGroup}>
                  <View style={styles.trainingGroupRow}><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedCount === ids.length }} accessibilityLabel={`Select all ${group.label} submissions`} onPress={() => toggleTrainingGroup(group.submissions)} hitSlop={8}><Ionicons name={selectedCount === ids.length ? "checkbox" : selectedCount ? "remove-circle" : "square-outline"} size={25} color={selectedCount ? colors.primary : colors.textMuted} /></Pressable><Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpandedTrainingLabel(expanded ? null : group.label)} style={styles.trainingGroupOpen}><View style={styles.detectionCopy}><Text style={styles.trainingGroupTitle}>{group.label}</Text><Text style={styles.trainingGroupMeta}>{group.submissions.length} submission{group.submissions.length === 1 ? "" : "s"} · {selectedCount} selected</Text></View><Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color={colors.textMuted} /></Pressable></View>
                  {expanded ? <View style={styles.trainingDrilldown}>{group.submissions.map((detail) => {
                    const selected = selectedTrainingSubmissions.has(detail.submission.id);
                    const labels = [...new Set(detail.annotations.map(contributionProductLabel))];
                    const detailExpanded = expandedTrainingSubmission === detail.submission.id;
                    return <View key={detail.submission.id} style={[styles.trainingSubmissionDetail, selected && styles.trainingSelectionRowSelected]}>
                      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => toggleTrainingGroup([detail])} hitSlop={8}><Ionicons name={selected ? "checkbox" : "square-outline"} size={23} color={selected ? colors.primary : colors.textMuted} /></Pressable>
                      <Pressable accessibilityRole="button" accessibilityState={{ expanded: detailExpanded }} onPress={() => setExpandedTrainingSubmission(detailExpanded ? null : detail.submission.id)} style={styles.trainingSubmissionOpen}>
                        <View style={styles.detectionCopy}><Text style={styles.trainingSelectionTitle}>{labels.join(" · ")}</Text><Text style={styles.detectionMeta}>Submission #{detail.submission.id} · {detail.annotations.length} annotation{detail.annotations.length === 1 ? "" : "s"}</Text></View>
                        <Ionicons name={detailExpanded ? "chevron-up" : "chevron-down"} size={18} color={colors.textMuted} />
                      </Pressable>
                      {detailExpanded ? <View style={styles.trainingSubmissionPreview}><Image source={{ uri: getScanImageUrl(detail.submission.scan_id) }} style={[styles.trainingPreviewImage, { aspectRatio: detail.submission.image_width / detail.submission.image_height }]} resizeMode="contain" />{detail.annotations.map((annotation) => <View key={annotation.id} style={styles.quarantineAnnotation}><Text style={styles.annotationTitle}>{contributionProductLabel(annotation)}</Text><Text style={styles.annotationDetail}>{actionTitle(annotation.action)}</Text></View>)}</View> : null}
                    </View>;
                  })}</View> : null}
                </View>;
              })}
            </ScrollView>
            <AppButton label={`Train with ${selectedTrainingSubmissions.size} submission${selectedTrainingSubmissions.size === 1 ? "" : "s"}`} icon="school-outline" loading={lifecycle.action === "Train Candidate"} disabled={lifecycle.busy || selectedTrainingSubmissions.size === 0} onPress={startSelectedCandidateTraining} />
          </View>
        </View>
      </Modal>

      <Modal visible={showTrainingHistory} transparent animationType="slide" statusBarTranslucent onRequestClose={() => setShowTrainingHistory(false)}>
        <View style={styles.sheetBackdrop}><View style={styles.sheet}><View style={styles.imageHeader}><View><Text style={styles.imageTitle}>Training History</Text><Text style={styles.imageSubtitle}>Actual candidate training runs</Text></View><Pressable accessibilityLabel="Close training history" onPress={() => setShowTrainingHistory(false)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable></View><ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
          {progressStats?.training_history.length ? <View style={styles.trainingHistory}>{progressStats.training_history.map((run) => <View key={run.training_run_id} style={styles.trainingRow}><View style={styles.trainingMarker}><Ionicons name={run.status === "completed" ? "checkmark" : run.status === "running" ? "hourglass-outline" : "close"} size={18} color={run.status === "completed" ? colors.successFg : run.status === "running" ? colors.warningFg : colors.danger} /></View><View style={styles.detectionCopy}><Text style={styles.trainingModel}>{run.model_version ? displayNameForModel({ id: run.model_id, version: run.model_version }) : "No model produced"}</Text><Text style={styles.trainingMeta}>{new Date(run.ended_at || run.started_at).toLocaleString("en-GB")}</Text><Text style={styles.trainingMeta}>{run.submission_count} submissions · {run.annotation_count} annotations</Text></View><StatusBadge label={run.status.toUpperCase()} tone={run.status === "completed" ? "success" : run.status === "running" ? "warning" : "danger"} /></View>)}</View> : <EmptyState icon="time-outline" title="No training history" message="Training runs will appear here." />}
        </ScrollView></View></View>
      </Modal>

      <Modal visible={showRollbackSelector} transparent animationType="slide" statusBarTranslucent onRequestClose={() => setShowRollbackSelector(false)}>
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            {rollbackComparisonTarget ? <>
              <View style={styles.imageHeader}>
                <View><Text style={styles.imageTitle}>Compare Models</Text><Text style={styles.imageSubtitle}>Cached comparison against the current active model</Text></View>
                <Pressable accessibilityLabel="Back to rollback models" onPress={() => { setRollbackComparisonTarget(null); setRollbackComparison(null); setRollbackComparisonError(""); }} hitSlop={10}><Ionicons name="arrow-back" size={25} color={colors.navy} /></Pressable>
              </View>
              <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
                {rollbackComparisonError ? <View style={styles.errorBox}><Text style={styles.errorText}>{rollbackComparisonError}</Text></View> : null}
                {rollbackComparison?.available && rollbackComparison.comparison ? <>
                  <View style={styles.rollbackComparisonModels}><View style={styles.detectionCopy}><Text style={styles.modelRole}>CURRENT ACTIVE</Text><Text style={styles.modelVersion}>{displayNameForModel(rollbackComparison.comparison.active_model)}</Text></View><View style={styles.detectionCopy}><Text style={styles.modelRole}>PREVIOUS MODEL</Text><Text style={styles.modelVersion}>{displayNameForModel(rollbackComparison.comparison.rollback_target)}</Text></View></View>
                  <Text style={styles.trainingMeta}>Historical comparison from {new Date(rollbackComparison.comparison.created_at).toLocaleString("en-GB")} · Dataset {rollbackComparison.comparison.dataset_version}</Text>
                  <View style={styles.metricHeader}><Text style={styles.metricName}>METRIC</Text><Text style={styles.metricNumber}>ACTIVE</Text><Text style={styles.metricNumber}>PREVIOUS</Text><Text style={styles.metricDelta}>CHANGE</Text></View>
                  {METRIC_ROWS.map(({ key, label }) => { const difference = rollbackComparison.comparison?.metric_differences[key]; return <View key={key} style={styles.metricRow}><Text style={styles.metricName}>{label}</Text><Text style={styles.metricNumber}>{formatMetric(rollbackComparison.comparison?.active_metrics[key])}</Text><Text style={styles.metricNumber}>{formatMetric(rollbackComparison.comparison?.rollback_target_metrics[key])}</Text><Text style={[styles.metricDelta, difference != null && difference > 0 ? styles.positiveDelta : difference != null && difference < 0 ? styles.negativeDelta : null]}>{formatMetricDifference(difference)}</Text></View>; })}
                  <View style={styles.sharedComparison}><Text style={styles.sectionTitle}>Product Support</Text><Text style={styles.actionHint}>Shared products: {rollbackComparison.comparison.class_comparison.shared_classes.length}</Text><Text style={styles.actionHint}>Only in {activeModelName}: {rollbackComparison.comparison.class_comparison.only_in_active.length}</Text><Text style={styles.actionHint}>Only in {rollbackTargetDisplayName(rollbackComparisonTarget)}: {rollbackComparison.comparison.class_comparison.only_in_rollback_target.length}</Text></View>
                </> : !rollbackComparisonError ? <EmptyState icon="information-circle-outline" title="No cached comparison" message={`No cached comparison is available between ${rollbackTargetDisplayName(rollbackComparisonTarget)} and ${activeModelName}. You can still select this model for rollback.`} /> : null}
              </ScrollView>
              <AppButton label="Back" variant="secondary" onPress={() => { setRollbackComparisonTarget(null); setRollbackComparison(null); setRollbackComparisonError(""); }} />
            </> : <>
              <View style={styles.imageHeader}><View><Text style={styles.imageTitle}>Select Model to Roll Back To</Text><Text style={styles.imageSubtitle}>Previous production models</Text></View><Pressable accessibilityLabel="Close rollback models" onPress={() => setShowRollbackSelector(false)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable></View>
              <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
                {progressStats?.rollback_targets.length ? progressStats.rollback_targets.map((model) => { const selected = selectedRollbackVersion === model.version; const modelName = rollbackTargetDisplayName(model); return <View key={model.id} style={[styles.rollbackChoice, selected && styles.rollbackChoiceSelected]}><Pressable accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`Select ${modelName} for rollback`} onPress={() => setSelectedRollbackVersion(model.version)} style={styles.rollbackChoiceMain}><Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={24} color={selected ? colors.primary : colors.textMuted} /><View style={styles.detectionCopy}><Text style={styles.modelVersion}>{modelName}</Text><Text style={styles.trainingMeta}>Previously active · {new Date(model.archived_at || model.last_activated_at || model.created_at).toLocaleDateString("en-GB")}</Text><Text style={styles.trainingMeta}>{model.classes_available ? `${model.supported_product_count} supported products` : "Product support metadata unavailable"}</Text></View></Pressable><AppButton label="Compare against active" icon="stats-chart-outline" variant="secondary" loading={loadingRollbackComparison === model.version} disabled={loadingRollbackComparison !== null} onPress={() => viewRollbackComparison(model)} /></View>; }) : <EmptyState icon="arrow-undo-outline" title="No previous production models" message="A previous active model will appear here when rollback is available." />}
                {rollbackComparisonError ? <View style={styles.errorBox}><Text style={styles.errorText}>{rollbackComparisonError}</Text></View> : null}
              </ScrollView>
              <View style={styles.rollbackFooter}><View style={styles.detectionAction}><AppButton label="Cancel" variant="secondary" onPress={() => setShowRollbackSelector(false)} /></View><View style={styles.detectionAction}><AppButton label={selectedRollbackVersion ? `Rollback to ${rollbackTargetDisplayName(progressStats?.rollback_targets.find((model) => model.version === selectedRollbackVersion))}` : "Select a model"} icon="arrow-undo-outline" variant="danger" disabled={!selectedRollbackVersion || lifecycle.busy || Boolean(lifecycleMutation)} loading={lifecycleMutation === "Rollback Model"} onPress={() => selectedRollbackVersion && confirmRollback(selectedRollbackVersion)} /></View></View>
            </>}
          </View>
        </View>
      </Modal>

      <Modal visible={showQuarantine} transparent animationType="slide" statusBarTranslucent onRequestClose={() => setShowQuarantine(false)}>
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.imageHeader}>
              <View><Text style={styles.imageTitle}>Quarantine</Text><Text style={styles.imageSubtitle}>{quarantinedSubmissions.length} submission{quarantinedSubmissions.length === 1 ? "" : "s"} excluded · {selectedQuarantineSubmissions.size} selected</Text></View>
              <Pressable accessibilityLabel="Close quarantine" onPress={() => setShowQuarantine(false)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable>
            </View>

            {quarantinedSubmissions.length ? <View style={styles.selectionControls}>
              <Text style={styles.selectionAvailable}>Select submissions to restore for the next training run</Text>
              <View style={styles.selectionControlButtons}>
                <Pressable accessibilityRole="button" onPress={() => setSelectedQuarantineSubmissions(new Set(quarantinedSubmissions.map((detail) => detail.submission.id)))} style={styles.selectionControl}><Text style={styles.selectionControlText}>Select all</Text></Pressable>
                <Pressable accessibilityRole="button" disabled={selectedQuarantineSubmissions.size === 0} onPress={() => setSelectedQuarantineSubmissions(new Set())} style={styles.selectionControl}><Text style={[styles.selectionControlText, selectedQuarantineSubmissions.size === 0 && styles.selectionControlDisabled]}>Clear</Text></Pressable>
              </View>
            </View> : null}

            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
              {quarantineMessage ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{quarantineMessage}</Text></View> : null}
              {quarantineError ? <View style={styles.errorBox}><Text style={styles.errorText}>{quarantineError}</Text></View> : null}
              {quarantineLabelGroups.length ? quarantineLabelGroups.map((group) => {
                const expanded = expandedQuarantineLabel === group.label;
                const groupIds = [...new Set(group.submissions.map((detail) => detail.submission.id))];
                const selectedCount = groupIds.filter((id) => selectedQuarantineSubmissions.has(id)).length;
                const allSelected = groupIds.length > 0 && selectedCount === groupIds.length;
                return <View key={group.label} style={styles.trainingGroup}>
                  <View style={styles.trainingGroupRow}>
                    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: allSelected }} accessibilityLabel={`Select all quarantined ${group.label} submissions`} onPress={() => toggleQuarantineGroup(group.submissions)} hitSlop={8}>
                      <Ionicons name={allSelected ? "checkbox" : selectedCount ? "remove-circle" : "square-outline"} size={25} color={selectedCount ? colors.primary : colors.textMuted} />
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpandedQuarantineLabel(expanded ? null : group.label)} style={styles.trainingGroupOpen}>
                      <View style={styles.quarantineGroupIcon}><Ionicons name="archive-outline" size={19} color={colors.danger} /></View>
                      <View style={styles.detectionCopy}><Text style={styles.trainingGroupTitle}>{group.label}</Text><Text style={styles.trainingGroupMeta}>{groupIds.length} submission{groupIds.length === 1 ? "" : "s"} · {selectedCount} selected</Text></View>
                      <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color={colors.textMuted} />
                    </Pressable>
                  </View>

                  {expanded ? <View style={styles.trainingDrilldown}>{group.submissions.map((detail) => {
                    const submissionExpanded = expandedQuarantineSubmission === detail.submission.id;
                    const selected = selectedQuarantineSubmissions.has(detail.submission.id);
                    const labels = [...new Set(detail.annotations.map(contributionProductLabel))];
                    return <View key={detail.submission.id} style={[styles.quarantineSubmission, selected && styles.trainingSelectionRowSelected]}>
                      <View style={styles.quarantineSubmissionRow}>
                        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`Select submission ${detail.submission.id}`} onPress={() => toggleQuarantineGroup([detail])} hitSlop={8}>
                          <Ionicons name={selected ? "checkbox" : "square-outline"} size={23} color={selected ? colors.primary : colors.textMuted} />
                        </Pressable>
                        <Pressable accessibilityRole="button" accessibilityState={{ expanded: submissionExpanded }} onPress={() => {
                          setExpandedQuarantineSubmission(submissionExpanded ? null : detail.submission.id);
                          setFocusedQuarantineAnnotation(submissionExpanded ? null : detail.annotations[0]?.id ?? null);
                        }} style={styles.trainingGroupOpen}>
                          <View style={styles.detectionCopy}><Text style={styles.trainingSelectionTitle}>Submission #{detail.submission.id}</Text><Text style={styles.detectionMeta}>{labels.join(" · ")} · {detail.annotations.length} annotation{detail.annotations.length === 1 ? "" : "s"}</Text></View>
                          <Ionicons name={submissionExpanded ? "chevron-up" : "chevron-down"} size={18} color={colors.textMuted} />
                        </Pressable>
                      </View>

                      {submissionExpanded ? (() => {
                        const annotationDetections = detail.annotations.map(annotationDetection);
                        const drawableDetections = annotationDetections.filter((detection) => hasDrawableBox(detection, detail.submission.image_width, detail.submission.image_height));
                        const missingBoxCount = annotationDetections.length - drawableDetections.length;
                        return <View style={styles.quarantineDetails}>
                          <DetectionImageViewer
                            imageUri={getScanImageUrl(detail.submission.scan_id)}
                            imageWidth={detail.submission.image_width}
                            imageHeight={detail.submission.image_height}
                            detections={drawableDetections}
                            highlightedDetectionId={focusedQuarantineAnnotation}
                            showLabels={false}
                            style={[styles.quarantineImage, { aspectRatio: detail.submission.image_width / detail.submission.image_height }]}
                          />
                          {missingBoxCount ? <Text style={styles.quarantineBoxNotice}>{missingBoxCount} annotation{missingBoxCount === 1 ? " has" : "s have"} no drawable box.</Text> : null}
                          {detail.annotations.map((annotation) => {
                            const focused = focusedQuarantineAnnotation === annotation.id;
                            const drawable = drawableDetections.some((detection) => detection.id === annotation.id);
                            return <Pressable
                              key={annotation.id}
                              accessibilityRole="radio"
                              accessibilityState={{ checked: focused }}
                              accessibilityLabel={`Focus annotation ${annotation.id}`}
                              onPress={() => setFocusedQuarantineAnnotation(annotation.id)}
                              style={[styles.quarantineAnnotation, focused && styles.quarantineAnnotationFocused]}
                            >
                              <View style={styles.quarantineAnnotationHeader}>
                                <Text style={styles.annotationTitle}>{contributionProductLabel(annotation)}</Text>
                                {focused ? <Ionicons name="locate" size={18} color={colors.amber} /> : null}
                              </View>
                              <Text style={styles.annotationDetail}>{actionTitle(annotation.action)} · Annotation #{annotation.id}{drawable ? "" : " · Box unavailable"}</Text>
                            </Pressable>;
                          })}
                          <View style={styles.quarantineActions}><View style={styles.detectionAction}><AppButton label="Reject permanently" variant="danger" icon="close-circle-outline" disabled={quarantineMutation !== null} onPress={() => confirmPermanentQuarantineRejection(detail.submission.id)} /></View><View style={styles.detectionAction}><AppButton label="Restore this" icon="refresh-outline" loading={quarantineMutation === detail.submission.id} disabled={quarantineMutation !== null} onPress={() => applyQuarantineAction(detail.submission.id, "restore")} /></View></View>
                        </View>;
                      })() : null}
                    </View>;
                  })}</View> : null}
                </View>;
              }) : <EmptyState icon="shield-checkmark-outline" title="Nothing quarantined" message="Rejected candidate data will appear here." />}
            </ScrollView>

            {quarantinedSubmissions.length ? <AppButton label={`Restore ${selectedQuarantineSubmissions.size} selected`} icon="refresh-outline" loading={quarantineMutation === -1} disabled={quarantineMutation !== null || selectedQuarantineSubmissions.size === 0} onPress={restoreSelectedQuarantinedSubmissions} /> : null}
            <AppButton label="Continue to Train Model" icon="school-outline" variant="secondary" disabled={Boolean(progressStats?.latest_candidate)} onPress={returnToTrainingSelection} />
            {progressStats?.latest_candidate ? <Text style={styles.actionHint}>Training will unlock after the current candidate is resolved. Your quarantine selections can be restored now.</Text> : null}
          </View>
        </View>
      </Modal>

      <Modal visible={imageDetection !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setImageDetection(null)}>
        <View style={styles.imageBackdrop}>
          <View style={styles.imageModal}>
            <View style={styles.imageHeader}><View><Text style={styles.imageTitle}>{imageDetection?.label}</Text><Text style={styles.imageSubtitle}>Original image · Scan #{selectedScan?.id}</Text></View><Pressable accessibilityLabel="Close image" onPress={() => setImageDetection(null)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable></View>
            {selectedScan ? (
              <DetectionImageViewer
                imageUri={getScanImageUrl(selectedScan.id)}
                imageWidth={selectedScan.image_width}
                imageHeight={selectedScan.image_height}
                detections={detections}
                highlightedDetectionId={imageDetection?.id}
                style={styles.scanImage}
              />
            ) : null}
            <Text style={styles.imageNote}>Read-only original scan image. Bounding-box editing is not enabled yet.</Text>
          </View>
        </View>
      </Modal>

      <Modal visible={editDetection !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => !savingLabel && setEditDetection(null)}>
        <KeyboardAvoidingView style={styles.imageBackdrop} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <ScrollView contentContainerStyle={styles.labelModal} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            <View style={styles.imageHeader}>
              <View><Text style={styles.imageTitle}>Correct product label</Text><Text style={styles.imageSubtitle}>Original: {editDetection?.label}</Text></View>
              <Pressable accessibilityLabel="Close label editor" disabled={savingLabel} onPress={() => setEditDetection(null)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable>
            </View>
            <Text style={styles.inputLabel}>Final product label</Text>
            <ProductLabelInput value={finalLabel} onChangeText={(value) => { setFinalLabel(value); setLabelError(""); }} suggestions={productLabelSuggestions} placeholder="Enter the correct label" autoFocus error={Boolean(labelError)} />
            {labelError ? <Text style={styles.modalError}>{labelError}</Text> : null}
            <View style={styles.modalActions}>
              <AppButton label="Submit Correction" icon="checkmark" loading={savingLabel} onPress={saveRelabel} />
              <AppButton label="Cancel" variant="ghost" disabled={savingLabel} onPress={() => setEditDetection(null)} />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={removeDetection !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => !removingDetectionId && setRemoveDetection(null)}>
        <View style={styles.imageBackdrop}>
          <View style={styles.labelModal}>
            <View style={styles.confirmIcon}><Ionicons name="trash-outline" size={28} color={colors.danger} /></View>
            <Text style={styles.confirmTitle}>Remove this detection?</Text>
            <Text style={styles.confirmMessage}>
              Mark <Text style={styles.confirmLabel}>{removeDetection?.label}</Text> as an incorrect YOLO detection? The original prediction will be preserved and your feedback will be submitted for review.
            </Text>
            {removeError ? <Text style={styles.modalError}>{removeError}</Text> : null}
            <View style={styles.modalActions}>
              <AppButton label="Submit as False Positive" icon="trash-outline" variant="danger" loading={removingDetectionId !== null} onPress={confirmRemoveDetection} />
              <AppButton label="Cancel" variant="ghost" disabled={removingDetectionId !== null} onPress={() => setRemoveDetection(null)} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={confirmDetection !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => !confirmingDetectionId && setConfirmDetection(null)}>
        <View style={styles.imageBackdrop}>
          <View style={styles.labelModal}>
            <View style={styles.confirmSuccessIcon}><Ionicons name="checkmark" size={30} color={colors.successFg} /></View>
            <Text style={styles.confirmTitle}>Confirm this detection?</Text>
            <Text style={styles.confirmMessage}>
              Confirm that <Text style={styles.confirmLabel}>{confirmDetection?.label}</Text> and its bounding box are correct. The original YOLO prediction will remain unchanged.
            </Text>
            {confirmError ? <Text style={styles.modalError}>{confirmError}</Text> : null}
            <View style={styles.modalActions}>
              <AppButton label="Confirm Detection" icon="checkmark-circle-outline" loading={confirmingDetectionId !== null} onPress={submitDetectionConfirmation} />
              <AppButton label="Cancel" variant="ghost" disabled={confirmingDetectionId !== null} onPress={() => setConfirmDetection(null)} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={contributionImage !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setContributionImage(null)}>
        <View style={styles.imageBackdrop}>
          <View style={styles.imageModal}>
            <View style={styles.imageHeader}>
              <View><Text style={styles.imageTitle}>{contributionImage ? actionTitle(contributionImage.annotation.action) : "Contribution"}</Text><Text style={styles.imageSubtitle}>Original image · Scan #{contributionImage?.submission.scan_id}</Text></View>
              <Pressable accessibilityLabel="Close contribution image" onPress={() => setContributionImage(null)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable>
            </View>
            {contributionImage ? (
              <DetectionImageViewer
                imageUri={getScanImageUrl(contributionImage.submission.scan_id)}
                imageWidth={contributionImage.submission.image_width}
                imageHeight={contributionImage.submission.image_height}
                detections={[contributionDetection(contributionImage)]}
                highlightedDetectionId={contributionImage.annotation.id}
                style={styles.scanImage}
              />
            ) : null}
            <Text style={styles.imageNote}>The highlighted box is stored with this contribution in original-image coordinates.</Text>
          </View>
        </View>
      </Modal>

      <Modal visible={editContribution !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => !savingContribution && setEditContribution(null)}>
        <KeyboardAvoidingView style={styles.imageBackdrop} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <ScrollView contentContainerStyle={styles.labelModal} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            <View style={styles.imageHeader}>
              <View><Text style={styles.imageTitle}>Edit pending label</Text><Text style={styles.imageSubtitle}>Original: {editContribution?.annotation.original_label}</Text></View>
              <Pressable accessibilityLabel="Close contribution editor" disabled={savingContribution} onPress={() => setEditContribution(null)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable>
            </View>
            <Text style={styles.inputLabel}>Final product label</Text>
            <ProductLabelInput value={contributionLabel} onChangeText={(value) => { setContributionLabel(value); setContributionEditError(""); }} suggestions={productLabelSuggestions} placeholder="Enter the correct label" autoFocus error={Boolean(contributionEditError)} />
            {contributionEditError ? <Text style={styles.modalError}>{contributionEditError}</Text> : null}
            <View style={styles.modalActions}>
              <AppButton label="Save Label" icon="checkmark" loading={savingContribution} onPress={saveContributionLabel} />
              <AppButton label="Cancel" variant="ghost" disabled={savingContribution} onPress={() => setEditContribution(null)} />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={boxEditor !== null}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => !savingBox && setBoxEditor(null)}
      >
        <KeyboardAvoidingView
          style={styles.boxEditorScreen}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.boxEditorScreenContent}>
            <View style={styles.imageHeader}>
              <View style={styles.detectionCopy}>
                <Text style={styles.imageTitle}>Edit bounding box</Text>
                <Text style={styles.imageSubtitle}>
                  Drag the box to move it · Drag a corner to resize
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Close box editor"
                disabled={savingBox}
                onPress={() => setBoxEditor(null)}
                hitSlop={10}
              >
                <Ionicons name="close" size={27} color={colors.navy} />
              </Pressable>
            </View>

            {boxEditor ? (
              <BoundingBoxEditor
                key={`box-editor-${boxEditor.scanId}-${boxEditor.source}`}
                imageUri={getScanImageUrl(boxEditor.scanId)}
                imageWidth={boxEditor.imageWidth}
                imageHeight={boxEditor.imageHeight}
                box={boxEditor.box}
                label={boxEditor.label}
                onBoxChange={(box) =>
                  setBoxEditor((current) =>
                    current ? { ...current, box } : null
                  )
                }
              />
            ) : null}

            {boxEditor?.source === "add" ? (
              <>
                <Text style={styles.inputLabel}>Product label</Text>
                <ProductLabelInput
                  value={boxEditor.label}
                  onChangeText={(label) => {
                    setBoxError("");
                    setBoxEditor((current) =>
                      current ? { ...current, label } : null
                    );
                  }}
                  suggestions={productLabelSuggestions}
                  placeholder="Enter the missed product label"
                  error={Boolean(boxError && !boxEditor.label.trim())}
                />
              </>
            ) : null}

            {boxError ? <Text style={styles.modalError}>{boxError}</Text> : null}

            <View style={styles.boxEditorActions}>
              <View style={styles.detectionAction}>
                <AppButton
                  label={boxEditor?.source === "add" ? "Clear Box" : "Reset"}
                  icon="refresh"
                  variant="ghost"
                  disabled={savingBox || !boxEditor?.box}
                  onPress={() =>
                    setBoxEditor((current) =>
                      current ? { ...current, box: current.originalBox } : null
                    )
                  }
                />
              </View>
              <View style={styles.detectionAction}>
                <AppButton
                  label="Save Box"
                  icon="checkmark"
                  loading={savingBox}
                  onPress={saveBoxCorrection}
                />
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.xl, gap: spacing.lg, paddingBottom: 44 },
  tabs: { flexDirection: "row", backgroundColor: colors.surfaceMuted, borderRadius: radius.lg, padding: 4, gap: 4 },
  tab: { flex: 1, minHeight: 44, borderRadius: radius.md, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.xs },
  activeTab: { backgroundColor: colors.surface, shadowColor: colors.navy, shadowOpacity: 0.08, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  tabText: { fontSize: 13, fontWeight: "700", color: colors.textMuted, textAlign: "center" },
  activeTabText: { color: colors.primary },
  placeholder: { alignItems: "center", paddingVertical: spacing.xxl, gap: spacing.sm },
  placeholderIcon: { width: 62, height: 62, borderRadius: 31, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center", marginBottom: spacing.xs },
  placeholderTitle: { ...typography.section, color: colors.navy, textAlign: "center", marginTop: spacing.xs },
  placeholderMessage: { ...typography.body, color: colors.textMuted, textAlign: "center", lineHeight: 21, maxWidth: 330 },
  note: { flexDirection: "row", gap: spacing.sm, backgroundColor: colors.infoBg, borderRadius: radius.lg, padding: spacing.md },
  noteText: { flex: 1, color: colors.infoFg, fontSize: 13, lineHeight: 18 },
  suggestions: { gap: spacing.md },
  manualAnnotationCallout: { gap: spacing.md },
  manualAnnotationIcon: { width: 48, height: 48, borderRadius: radius.lg, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  manualAnnotationTitle: { ...typography.section, color: colors.navy },
  targetedHelp: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: "#93c5fd", borderRadius: radius.lg, padding: spacing.md },
  targetedHelpTitle: { color: colors.navy, fontWeight: "800" },
  targetedHelpText: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  targetedDetection: { borderWidth: 2, borderColor: colors.primary, borderRadius: radius.xl, padding: 2 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  sectionTitle: { ...typography.section, color: colors.navy },
  sectionSubtitle: { color: colors.textMuted, fontSize: 13, marginTop: 3 },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingVertical: spacing.lg },
  loadingText: { color: colors.textMuted, fontWeight: "600" },
  scanList: { gap: spacing.sm, paddingVertical: 2 },
  filterList: { gap: spacing.sm, paddingVertical: 2 },
  searchInput: { minHeight: 48, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, paddingHorizontal: spacing.md, color: colors.textPrimary, backgroundColor: colors.surface },
  filterCaption: { color: colors.textMuted, fontSize: 11, fontWeight: "800", letterSpacing: 0.8, marginBottom: spacing.xs, marginTop: spacing.md },
  sortOptions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  sortChip: { flexGrow: 1, minWidth: 88 },
  filterChip: { minHeight: 38, paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  selectedFilterChip: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterText: { color: colors.textSecondary, fontWeight: "700", fontSize: 13 },
  selectedFilterText: { color: colors.primaryText },
  scanChip: { minWidth: 126, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md, gap: 3 },
  selectedScanChip: { backgroundColor: colors.primary, borderColor: colors.primary },
  scanChipTitle: { fontWeight: "800", color: colors.navy },
  scanChipMeta: { color: colors.textMuted, fontSize: 13 },
  selectedScanText: { color: colors.primaryText },
  errorBox: { gap: spacing.sm, backgroundColor: colors.dangerBg, padding: spacing.md, borderRadius: radius.lg },
  errorText: { color: colors.danger, textAlign: "center", fontWeight: "600" },
  detectionTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  contributionHeader: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  contributionProduct: { flexShrink: 1, color: colors.navy, fontSize: 18, lineHeight: 23, fontWeight: "900" },
  contributionAction: { flexShrink: 1, color: colors.textSecondary, fontSize: 13, lineHeight: 18, fontWeight: "700" },
  contributionGroup: { gap: spacing.md },
  groupHeading: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.md, paddingHorizontal: spacing.xs, paddingTop: spacing.sm },
  groupTitle: { flex: 1, color: colors.navy, fontSize: 19, lineHeight: 24, fontWeight: "900" },
  groupCount: { color: colors.textMuted, fontSize: 13, fontWeight: "700" },
  detectionIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  removeIcon: { backgroundColor: colors.dangerBg },
  detectionCopy: { flex: 1, gap: 3 },
  detectionLabel: { fontSize: 17, fontWeight: "800", color: colors.navy },
  detectionMeta: { color: colors.textMuted, fontSize: 13 },
  pendingRow: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.warningBg, borderRadius: radius.lg, padding: spacing.sm },
  pendingText: { flex: 1, color: colors.warningFg, fontSize: 13, fontWeight: "600" },
  falsePositiveRow: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.dangerBg, borderRadius: radius.lg, padding: spacing.sm },
  falsePositiveText: { flex: 1, color: colors.danger, fontSize: 13, fontWeight: "700" },
  confirmedRow: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.successBg, borderRadius: radius.lg, padding: spacing.sm },
  confirmedText: { flex: 1, color: colors.successFg, fontSize: 13, fontWeight: "700" },
  detectionActions: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, flexDirection: "row", gap: spacing.sm },
  detectionActionsSecondary: { marginTop: spacing.sm, flexDirection: "row", gap: spacing.sm },
  detectionAction: { flex: 1 },
  removeAction: { marginTop: spacing.sm },
  confirmAction: { marginTop: spacing.sm },
  labelDetail: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  detailCaption: { color: colors.textMuted, fontSize: 13 },
  detailValue: { flex: 1, color: colors.navy, fontWeight: "800", textAlign: "right" },
  changeStory: { marginTop: spacing.md, padding: spacing.md, gap: spacing.sm, backgroundColor: colors.surfaceMuted, borderRadius: radius.lg, alignItems: "flex-start" },
  storyStep: { gap: 3, width: "100%" },
  storyValue: { color: colors.navy, fontWeight: "800", fontSize: 14, lineHeight: 19 },
  usedModelBox: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.successBg, borderRadius: radius.lg, padding: spacing.md },
  usedModelTitle: { color: colors.successFg, fontSize: 13, fontWeight: "800" },
  usedModelMeta: { color: colors.successFg, fontSize: 12, lineHeight: 17 },
  lifecycleStateRow: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.sm, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted },
  lifecycleStateText: { flex: 1, color: colors.textSecondary, fontSize: 12, lineHeight: 17, fontWeight: "600" },
  readOnlyText: { marginTop: spacing.sm, color: colors.textMuted, fontSize: 13, fontWeight: "600", textAlign: "center" },
  moderationDivider: { marginTop: spacing.xl, paddingTop: spacing.xl, borderTopWidth: 2, borderTopColor: colors.border, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.md },
  queueTitleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  moderationHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, marginBottom: spacing.md },
  moderationImage: { width: "100%", height: 300, backgroundColor: colors.surfaceMuted, borderRadius: radius.lg },
  moderationAnnotations: { marginTop: spacing.md, gap: spacing.sm },
  moderationAnnotation: { backgroundColor: colors.surfaceMuted, borderRadius: radius.lg, padding: spacing.md, gap: 5 },
  annotationTitleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  annotationTitle: { color: colors.navy, fontWeight: "800", fontSize: 15 },
  annotationId: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  annotationDetail: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  annotationValue: { color: colors.textSecondary, fontWeight: "700" },
  detailsToggle: { minHeight: 44, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.xs },
  detailsToggleText: { color: colors.primary, fontSize: 13, fontWeight: "800" },
  coordinateDetails: { gap: spacing.xs, paddingTop: spacing.xs, borderTopWidth: 1, borderTopColor: colors.border },
  moderationActions: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, flexDirection: "row", gap: spacing.sm },
  progressGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  progressMetric: { width: "48%", minHeight: 112, borderRadius: radius.xl, padding: spacing.lg, justifyContent: "center", gap: spacing.xs },
  progressValue: { fontSize: 32, fontWeight: "900" },
  progressLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: "700", lineHeight: 18 },
  classChips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.md },
  classChip: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.pill, backgroundColor: colors.primarySoft },
  classChipText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  managementActions: { marginTop: spacing.sm },
  managementRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: spacing.sm },
  managementIcon: { width: 38, height: 38, borderRadius: 13, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  managementTitle: { color: colors.navy, fontSize: 14, fontWeight: "900" },
  managementMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  quarantineAction: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.danger, borderRadius: radius.lg, backgroundColor: colors.dangerBg },
  quarantineActionText: { color: colors.danger, fontSize: 13, fontWeight: "900" },
  modelRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: spacing.md, marginTop: spacing.sm },
  heroModelRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md },
  heroModelVersion: { color: colors.navy, fontSize: 24, lineHeight: 29, fontWeight: "900", flexShrink: 1 },
  candidateRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md, marginTop: spacing.sm },
  modelIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  modelRole: { color: colors.textMuted, fontSize: 12, fontWeight: "800", letterSpacing: 0.7 },
  modelVersion: { color: colors.navy, fontSize: 14, fontWeight: "800", marginTop: 2 },
  lifecycleEmpty: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted },
  lifecycleEmptyText: { flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  selectionControls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, marginVertical: spacing.md },
  selectionAvailable: { color: colors.textSecondary, fontSize: 13, fontWeight: "800" },
  selectionControlButtons: { flexDirection: "row", gap: spacing.xs },
  selectionControl: { minHeight: 38, justifyContent: "center", paddingHorizontal: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  selectionControlText: { color: colors.primary, fontSize: 13, fontWeight: "900" },
  selectionControlDisabled: { color: colors.textMuted },
  trainingSelectionRowSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  trainingSelectionTitle: { color: colors.navy, fontSize: 14, lineHeight: 19, fontWeight: "900" },
  comparisonHeading: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, marginBottom: spacing.md },
  metricHeader: { flexDirection: "row", alignItems: "center", paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  metricRow: { flexDirection: "row", alignItems: "center", minHeight: 44, borderBottomWidth: 1, borderBottomColor: colors.border },
  metricName: { flex: 1.15, color: colors.textSecondary, fontSize: 12, fontWeight: "700" },
  metricNumber: { flex: 0.9, color: colors.navy, fontSize: 12, fontWeight: "800", textAlign: "right" },
  metricDelta: { flex: 0.9, color: colors.textMuted, fontSize: 12, fontWeight: "800", textAlign: "right" },
  positiveDelta: { color: colors.successFg },
  negativeDelta: { color: colors.danger },
  comparisonSummary: { color: colors.textSecondary, fontSize: 13, fontWeight: "600", lineHeight: 19, marginTop: spacing.md },
  sharedComparison: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.lg, paddingTop: spacing.lg },
  readinessBox: { marginTop: spacing.sm, flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, borderRadius: radius.lg, padding: spacing.md },
  readinessReady: { backgroundColor: colors.successBg },
  readinessBlocked: { backgroundColor: colors.warningBg },
  readinessTitle: { color: colors.navy, fontSize: 15, fontWeight: "900" },
  readinessReason: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  metricCards: { gap: spacing.sm, marginTop: spacing.lg },
  metricCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm, backgroundColor: colors.surfaceMuted },
  metricCardHeading: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  metricCardName: { color: colors.navy, fontSize: 15, fontWeight: "900" },
  metricVerdict: { color: colors.textMuted, fontSize: 12, fontWeight: "800" },
  metricValues: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: spacing.md },
  metricValueLabel: { color: colors.textMuted, fontSize: 10, fontWeight: "800", letterSpacing: 0.6 },
  metricValue: { color: colors.navy, fontSize: 17, fontWeight: "900", marginTop: 2 },
  metricCardDelta: { color: colors.textMuted, fontSize: 14, fontWeight: "900" },
  classList: { gap: spacing.sm, marginTop: spacing.md },
  classRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, minHeight: 44, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.primarySoft },
  className: { flex: 1, flexShrink: 1, color: colors.navy, fontSize: 14, fontWeight: "800" },
  classMetric: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", textAlign: "right" },
  removedClasses: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.dangerBg },
  removedTitle: { color: colors.danger, fontSize: 14, fontWeight: "900" },
  removedText: { color: colors.danger, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  technicalDetails: { gap: spacing.xs, marginTop: spacing.sm, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted },
  trainingHistory: { marginTop: spacing.md },
  trainingRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  trainingMarker: { width: 34, height: 34, borderRadius: 12, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  trainingModel: { color: colors.navy, fontSize: 13, fontWeight: "800" },
  trainingMeta: { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  lifecycleActions: { gap: spacing.sm, marginTop: spacing.lg },
  actionHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  jobStatus: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.primarySoft, borderRadius: radius.lg, padding: spacing.md, marginTop: spacing.md },
  jobTitle: { color: colors.navy, fontWeight: "800", fontSize: 13 },
  jobMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  rollbackSection: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.lg, paddingTop: spacing.md },
  rollbackRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md },
  rollbackChoice: { gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface },
  rollbackChoiceSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  rollbackChoiceMain: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 48 },
  rollbackFooter: { flexDirection: "row", gap: spacing.sm },
  rollbackComparisonModels: { flexDirection: "row", gap: spacing.lg, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted },
  actionBreakdown: { marginTop: spacing.lg, gap: spacing.xs },
  actionRow: { minHeight: 66, flexDirection: "row", alignItems: "center", gap: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: spacing.sm },
  actionIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  actionLabel: { color: colors.navy, fontWeight: "800", fontSize: 14 },
  actionDescription: { color: colors.textMuted, fontSize: 12 },
  actionCount: { minWidth: 36, color: colors.primary, fontWeight: "900", fontSize: 24, textAlign: "right" },
  progressNote: { flexDirection: "row", gap: spacing.sm, backgroundColor: colors.infoBg, borderRadius: radius.lg, padding: spacing.md },
  successBox: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.successBg, borderRadius: radius.lg, padding: spacing.md },
  successText: { flex: 1, color: colors.successFg, fontWeight: "700", lineHeight: 19 },
  successLink: { color: colors.successFg, fontWeight: "900", marginTop: spacing.xs, textDecorationLine: "underline" },
  sheetBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(15, 23, 42, 0.55)" },
  sheet: { maxHeight: "94%", minHeight: "42%", gap: spacing.md, padding: spacing.lg, paddingBottom: spacing.xl, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, backgroundColor: colors.surface },
  sheetScroll: { flexGrow: 0 },
  sheetContent: { gap: spacing.sm, paddingBottom: spacing.md },
  sheetHelper: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  sheetQuarantineLink: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm, borderRadius: radius.md, backgroundColor: colors.dangerBg },
  sheetQuarantineText: { flex: 1, color: colors.danger, fontSize: 13, fontWeight: "900" },
  trainingGroup: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, overflow: "hidden" },
  trainingGroupRow: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, backgroundColor: colors.surface },
  trainingGroupOpen: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  trainingGroupTitle: { color: colors.navy, fontSize: 15, fontWeight: "900" },
  trainingGroupMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  trainingDrilldown: { gap: spacing.sm, padding: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surfaceMuted },
  trainingSubmissionDetail: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface },
  trainingThumbnail: { width: 72, maxHeight: 72, borderRadius: radius.md, backgroundColor: colors.border },
  wholeSubmissionNote: { color: colors.primary, fontSize: 11, fontWeight: "800", marginTop: 3 },
  quarantineCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, overflow: "hidden" },
  quarantineRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, backgroundColor: colors.surface },
  quarantineDetails: { gap: spacing.sm, padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surfaceMuted },
  quarantineImage: { width: "100%", maxHeight: 260, borderRadius: radius.lg, backgroundColor: colors.border },
  quarantineAnnotation: { padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 2, borderColor: "transparent" },
  quarantineAnnotationFocused: { borderColor: colors.amber },
  quarantineAnnotationHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  quarantineBoxNotice: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  quarantineActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  modelCardHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  modelDisplayName: { color: colors.navy, fontSize: 20, lineHeight: 25, fontWeight: "900" },
  modelVersionCompact: { color: colors.textMuted, fontSize: 12, lineHeight: 17, fontWeight: "700" },
  compactDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  candidateCompactRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  comparisonCompact: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted, gap: spacing.sm },
  comparisonCompactHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  comparisonCompactTitle: { color: colors.navy, fontSize: 15, fontWeight: "900" },
  comparisonCompactText: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  metricSummaryRow: { flexDirection: "row", gap: spacing.xs },
  metricSummaryItem: { flex: 1, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface },
  metricSummaryLabel: { color: colors.textMuted, fontSize: 9, lineHeight: 12, fontWeight: "800" },
  metricSummaryValue: { color: colors.navy, fontSize: 15, fontWeight: "900", marginTop: 3 },
  comparisonDetailsToggle: { minHeight: 38, flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: spacing.xs },
  comparisonDetailsText: { color: colors.primary, fontSize: 12, fontWeight: "900" },
  comparisonDetails: { gap: spacing.sm },
  primaryLifecycleAction: { gap: spacing.xs },
  systemDecision: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, borderRadius: radius.lg, backgroundColor: colors.primarySoft },
  systemDecisionText: { color: colors.textSecondary, fontSize: 13, fontWeight: "800" },
  quickActions: { flexDirection: "row", gap: spacing.sm },
  quickAction: { flex: 1, minHeight: 74, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface },
  quickActionDanger: { borderColor: colors.danger, backgroundColor: colors.dangerBg },
  quickActionIcon: { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: colors.primarySoft },
  quickActionIconDanger: { backgroundColor: colors.dangerBg },
  quickActionTitle: { color: colors.navy, fontSize: 13, fontWeight: "900" },
  quickActionTitleDanger: { color: colors.danger },
  quickActionMeta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  trainingSubmissionOpen: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  trainingSubmissionPreview: { width: "100%", gap: spacing.sm, paddingTop: spacing.sm },
  trainingPreviewImage: { width: "100%", maxHeight: 240, borderRadius: radius.md, backgroundColor: colors.border },
  quarantineGroupRow: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, backgroundColor: colors.surface },
  quarantineGroupIcon: { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: colors.dangerBg },
  quarantineSubmission: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, overflow: "hidden", backgroundColor: colors.surface },
  quarantineSubmissionRow: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.sm },
  imageBackdrop: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.72)", alignItems: "center", justifyContent: "center", padding: spacing.lg },
  imageModal: { width: "100%", maxWidth: 520, backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md },
  imageHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  imageTitle: { ...typography.section, color: colors.navy },
  imageSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  scanImage: { width: "100%", height: 430, backgroundColor: colors.surfaceMuted, borderRadius: radius.lg },
  imageNote: { color: colors.textMuted, fontSize: 12, textAlign: "center" },
  labelModal: { width: "100%", maxWidth: 460, backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md },
  boxEditorModal: { width: "100%", maxWidth: 560, backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, gap: spacing.md },
  boxEditorScreen: { flex: 1, backgroundColor: colors.background },
  boxEditorScreenContent: { flex: 1, padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.md },
  boxEditorActions: { flexDirection: "row", gap: spacing.sm },
  inputLabel: { color: colors.textSecondary, fontWeight: "700", fontSize: 13 },
  modalError: { color: colors.danger, backgroundColor: colors.dangerBg, borderRadius: radius.md, padding: spacing.sm, fontWeight: "600" },
  modalActions: { gap: spacing.sm },
  confirmIcon: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.dangerBg, alignItems: "center", justifyContent: "center", alignSelf: "center" },
  confirmSuccessIcon: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.successBg, alignItems: "center", justifyContent: "center", alignSelf: "center" },
  confirmTitle: { ...typography.section, color: colors.navy, textAlign: "center" },
  confirmMessage: { ...typography.body, color: colors.textMuted, lineHeight: 22, textAlign: "center" },
  confirmLabel: { color: colors.navy, fontWeight: "800" },
});

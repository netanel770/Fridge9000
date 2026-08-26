import { useEffect, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";

import { AppButton, Card, EmptyState, ScreenHeader, StatusBadge } from "../src/components/ui";
import { DetectionImageViewer } from "../src/components/DetectionImageViewer";
import { BoundingBoxEditor } from "../src/components/BoundingBoxEditor";
import { createAnnotationSubmission, getAIProgress, getAllInventory, getAnnotationSubmission, getAnnotationSubmissions, getLifecycleJob, getRecentScans, getScanDetections, getScanImageUrl, moderateAnnotationSubmission, promoteCandidate, rollbackModel, startCandidateComparison, startCandidateTraining, updateAnnotationBox, updateAnnotationLabel } from "../src/services/api";
import type { AIProgressResponse, AnnotationItem, AnnotationStatus, AnnotationSubmission, AnnotationSubmissionDetail, DetectionItem, InventoryItem, LifecycleJob, ModelMetrics, PromotionReason, RecentScan } from "../src/types/api";
import { getMinimumAnnotationBoxSize } from "../src/utils/imageCoordinates";
import type { ImageBoundingBox } from "../src/utils/imageCoordinates";
import { colors, radius, spacing, typography } from "../src/theme";

type TeachTab = "Suggestions" | "Contributions" | "AI Progress";

const TABS: TeachTab[] = ["Suggestions", "Contributions", "AI Progress"];
const CONTRIBUTION_FILTERS = ["All", "Pending", "Approved", "Rejected", "Used"] as const;
type ContributionFilter = typeof CONTRIBUTION_FILTERS[number];
type Contribution = { submission: AnnotationSubmission; annotation: AnnotationItem };
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
  if (annotation.action === "CONFIRM") return "Confirmed the AI prediction as correct";
  if (annotation.action === "RELABEL") return `Changed label to ${annotation.final_label || "a corrected product"}`;
  if (annotation.action === "REMOVE") return "Marked the AI prediction as incorrect";
  if (annotation.action === "ADJUST_BOX") return "Adjusted the detected product area";
  return `Added missed product: ${annotation.final_label || "Unlabeled product"}`;
}

function contributionStatus(status: AnnotationStatus, used: boolean) {
  if (used || status === "used") return "USED IN TRAINING";
  if (status === "pending") return "PENDING REVIEW";
  if (status === "approved") return "READY TO TRAIN";
  return "REJECTED";
}

function defaultAnnotationBox(imageWidth: number, imageHeight: number): ImageBoundingBox {
  return {
    x1: imageWidth * 0.25,
    y1: imageHeight * 0.25,
    x2: imageWidth * 0.75,
    y2: imageHeight * 0.75,
  };
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
    return `Existing-class performance changed by ${formatMetricDifference(reason.difference)}. Maximum allowed regression is ${formatMetricDifference(-reason.maximum_regression)}.`;
  }
  if (reason.code === "added_class_quality" && reason.value != null && reason.minimum != null) {
    return `New-product mAP50-95 is ${formatMetric(reason.value)}. Minimum required is ${formatMetric(reason.minimum)}.`;
  }
  if (reason.code === "added_class_below_minimum" && reason.classes && !Array.isArray(reason.classes) && reason.minimum != null) {
    const values = Object.entries(reason.classes).map(([name, value]) => `${name}: ${formatMetric(value)}`).join(", ");
    return `${values}. Each new product must reach ${formatMetric(reason.minimum)}.`;
  }
  if (reason.code === "removed_classes" && Array.isArray(reason.classes)) {
    return `Supported products cannot be removed: ${reason.classes.join(", ")}.`;
  }
  return reason.message;
}

function lifecyclePhaseLabel(job: LifecycleJob) {
  if (job.phase === "preparing") return "Preparing approved corrections and the base dataset...";
  if (job.phase === "uploading") return "Uploading the training package to Kaggle...";
  if (job.phase === "waiting_for_dataset") return "Waiting for Kaggle to prepare the training files...";
  if (job.phase === "queued" || job.status === "queued") return "Waiting for an available Kaggle GPU...";
  if (job.phase === "running") return "Training and testing the new model on Kaggle...";
  if (job.phase === "downloading") return "Downloading the candidate model and real metrics...";
  if (job.phase === "registering") return "Saving the new model safely...";
  return "Working safely in the background...";
}

const METRIC_ROWS: { key: keyof ModelMetrics; label: string }[] = [
  { key: "precision", label: "Precision" },
  { key: "recall", label: "Recall" },
  { key: "map50", label: "mAP50" },
  { key: "map50_95", label: "mAP50–95" },
];

export default function TeachFridgeScreen() {
  const { scanId: requestedScanIdParam, detectionId: requestedDetectionIdParam, addMissed } = useLocalSearchParams<{ scanId?: string; detectionId?: string; addMissed?: string }>();
  const requestedScanId = Number(requestedScanIdParam);
  const requestedDetectionId = Number(requestedDetectionIdParam);
  const hasValidRequestedScan = Number.isInteger(requestedScanId) && requestedScanId > 0;
  const hasTargetedDetection = hasValidRequestedScan && Number.isInteger(requestedDetectionId) && requestedDetectionId > 0;
  const [activeTab, setActiveTab] = useState<TeachTab>("Suggestions");
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
  const [progressStats, setProgressStats] = useState<AIProgressResponse | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [progressError, setProgressError] = useState("");
  const [lifecycleJob, setLifecycleJob] = useState<LifecycleJob | null>(null);
  const [lifecycleMessage, setLifecycleMessage] = useState("");
  const [lifecycleError, setLifecycleError] = useState("");
  const [lifecycleAction, setLifecycleAction] = useState<string | null>(null);
  const selectionRequest = useRef(0);
  const contributionsRequest = useRef(0);
  const moderationRequest = useRef(0);
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
      const recent = await getRecentScans(hasValidRequestedScan ? 50 : 10);
      setScans(recent);
      const requestedScan = hasValidRequestedScan ? recent.find((scan) => scan.id === requestedScanId) : undefined;
      const initialScan = hasValidRequestedScan ? requestedScan : recent[0];
      if (initialScan) {
        await selectScan(initialScan);
        if (requestedScan && addMissed === "1" && !handledRequestedScan.current) {
          handledRequestedScan.current = true;
          setBoxError("");
          setBoxEditor({
            source: "add",
            scanId: requestedScan.id,
            imageWidth: requestedScan.image_width,
            imageHeight: requestedScan.image_height,
            label: "",
            originalBox: null,
            box: defaultAnnotationBox(requestedScan.image_width, requestedScan.image_height),
          });
          try { setInventoryLabels(await getAllInventory()); } catch { setInventoryLabels([]); }
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
      const status = contributionFilter === "All" ? undefined : contributionFilter.toLowerCase() as AnnotationStatus;
      const submissions = await getAnnotationSubmissions(status);
      const details = await Promise.all(submissions.map((submission) => getAnnotationSubmission(submission.id)));
      if (contributionsRequest.current === requestId) {
        setContributions(details.flatMap((detail) => detail.annotations.map((annotation) => ({ submission: detail.submission, annotation }))));
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
  }, [activeTab, contributionFilter]);

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
    setLoadingProgress(true);
    setProgressError("");
    try {
      setProgressStats(await getAIProgress());
    } catch (caught) {
      setProgressStats(null);
      setProgressError(caught instanceof Error ? caught.message : "Could not load AI progress statistics.");
    } finally {
      setLoadingProgress(false);
    }
  }

  async function waitForLifecycleJob(initial: LifecycleJob) {
    let job = initial;
    setLifecycleJob(job);
    while (job.status === "queued" || job.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      job = await getLifecycleJob(job.job_id);
      setLifecycleJob(job);
    }
    if (job.status === "failed") throw new Error(job.error?.message || `${job.kind} failed.`);
    return job;
  }

  async function runLongLifecycleAction(label: string, start: () => Promise<LifecycleJob>) {
    setLifecycleAction(label);
    setLifecycleError("");
    setLifecycleMessage("");
    try {
      await waitForLifecycleJob(await start());
      setLifecycleMessage(`${label} completed successfully.`);
      await loadProgress();
    } catch (caught) {
      setLifecycleError(caught instanceof Error ? caught.message : `${label} failed.`);
      await loadProgress();
    } finally {
      setLifecycleAction(null);
    }
  }

  function confirmPromotion() {
    if (!progressStats?.latest_candidate || !progressStats.comparison) return;
    Alert.alert("Promote candidate?", `Make ${progressStats.latest_candidate.version} the active production model? The current model will remain available for rollback.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Promote", onPress: async () => {
        setLifecycleAction("Promote Candidate"); setLifecycleError(""); setLifecycleMessage("");
        try {
          await promoteCandidate(progressStats.latest_candidate!.version, progressStats.comparison!.id);
          setLifecycleMessage("Candidate promoted. The previous active model was archived.");
          await loadProgress();
        } catch (caught) { setLifecycleError(caught instanceof Error ? caught.message : "Promotion failed."); }
        finally { setLifecycleAction(null); }
      } },
    ]);
  }

  function confirmRollback(version: string) {
    Alert.alert("Rollback model?", `Restore ${version} as the active production model?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Rollback", style: "destructive", onPress: async () => {
        setLifecycleAction("Rollback Model"); setLifecycleError(""); setLifecycleMessage("");
        try { await rollbackModel(version); setLifecycleMessage(`Rolled back to ${version}.`); await loadProgress(); }
        catch (caught) { setLifecycleError(caught instanceof Error ? caught.message : "Rollback failed."); }
        finally { setLifecycleAction(null); }
      } },
    ]);
  }

  useEffect(() => {
    if (activeTab === "AI Progress") loadProgress();
  }, [activeTab]);

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
    setBoxError("");
    setBoxEditor({
      source: "add",
      scanId: selectedScan.id,
      imageWidth: selectedScan.image_width,
      imageHeight: selectedScan.image_height,
      label: "",
      originalBox: null,
      box: defaultAnnotationBox(selectedScan.image_width, selectedScan.image_height),
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

  const matchingLabels = finalLabel.trim()
    ? inventoryLabels.filter((item) => item.name.toLowerCase().includes(finalLabel.trim().toLowerCase()) && item.name.toLowerCase() !== finalLabel.trim().toLowerCase()).slice(0, 4)
    : inventoryLabels.slice(0, 4);

  const matchingContributionLabels = contributionLabel.trim()
    ? inventoryLabels.filter((item) => item.name.toLowerCase().includes(contributionLabel.trim().toLowerCase()) && item.name.toLowerCase() !== contributionLabel.trim().toLowerCase()).slice(0, 4)
    : inventoryLabels.slice(0, 4);

  const boxLabelQuery = boxEditor?.source === "add" ? boxEditor.label.trim() : "";
  const matchingBoxLabels = boxEditor?.source === "add"
    ? inventoryLabels.filter((item) => !boxLabelQuery || item.name.toLowerCase().includes(boxLabelQuery.toLowerCase())).filter((item) => item.name.toLowerCase() !== boxLabelQuery.toLowerCase()).slice(0, 4)
    : [];

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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
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

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
            {CONTRIBUTION_FILTERS.map((filter) => {
              const selected = contributionFilter === filter;
              return <Pressable key={filter} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => setContributionFilter(filter)} style={[styles.filterChip, selected && styles.selectedFilterChip]}>
                <Text style={[styles.filterText, selected && styles.selectedFilterText]}>{filter}</Text>
              </Pressable>;
            })}
          </ScrollView>

          {contributionMessage ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{contributionMessage}</Text></View> : null}
          {loadingContributions ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading contributions...</Text></View> : null}
          {contributionsError ? <View style={styles.errorBox}><Text style={styles.errorText}>{contributionsError}</Text><AppButton label="Try Again" variant="secondary" onPress={loadContributions} /></View> : null}
          {!loadingContributions && !contributionsError && contributions.length === 0 ? <Card><EmptyState icon="checkmark-done-outline" title="No contributions found" message={`There are no ${contributionFilter.toLowerCase()} contributions to show.`} /></Card> : null}

          {!loadingContributions && contributions.map((contribution) => {
            const { annotation, submission } = contribution;
            const latestUsage = annotation.training_usages?.[0] ?? submission.training_usages?.[0];
            const displayedStatus = latestUsage ? "used" : submission.status;
            const canEdit = submission.status === "pending" && ["RELABEL", "ADD"].includes(annotation.action);
            const canEditBox = submission.status === "pending" && annotation.action === "ADJUST_BOX";
            return <Card key={annotation.id}>
              <View style={styles.contributionHeader}>
                <View style={[styles.detectionIcon, annotation.action === "REMOVE" && styles.removeIcon]}><Ionicons name={annotation.action === "REMOVE" ? "trash-outline" : "create-outline"} size={22} color={annotation.action === "REMOVE" ? colors.danger : colors.primary} /></View>
                <View style={styles.detectionCopy}>
                  <Text style={styles.detectionLabel}>{actionTitle(annotation.action)}</Text>
                  <Text style={styles.detectionMeta}>Scan #{submission.scan_id} · {new Date(submission.created_at).toLocaleString("en-GB")}</Text>
                </View>
                <StatusBadge label={contributionStatus(displayedStatus, Boolean(latestUsage))} tone={statusTone(displayedStatus)} />
              </View>
              <View style={styles.changeStory}>
                <View style={styles.storyStep}><Text style={styles.detailCaption}>MODEL PREDICTED</Text><Text style={styles.storyValue}>{annotation.original_label || "No product detected"}</Text></View>
                <Ionicons name="arrow-down" size={17} color={colors.textMuted} />
                <View style={styles.storyStep}><Text style={styles.detailCaption}>YOUR CONTRIBUTION</Text><Text style={styles.storyValue}>{contributionChange(annotation)}</Text></View>
              </View>
              <View style={styles.detectionActions}>
                <View style={styles.detectionAction}><AppButton label="View Image" icon="image-outline" variant="secondary" onPress={() => setContributionImage(contribution)} /></View>
                {canEdit ? <View style={styles.detectionAction}><AppButton label="Edit Label" icon="create-outline" variant="ghost" onPress={() => openContributionEditor(contribution)} /></View> : null}
                {canEditBox ? <View style={styles.detectionAction}><AppButton label="Edit Box" icon="crop-outline" variant="ghost" onPress={() => openContributionBoxEditor(contribution)} /></View> : null}
              </View>
              {latestUsage ? <View style={styles.usedModelBox}><Ionicons name="sparkles" size={20} color={colors.successFg} /><View style={styles.detectionCopy}><Text style={styles.usedModelTitle}>Used in model {latestUsage.model_version}</Text><Text style={styles.usedModelMeta}>Training run {latestUsage.training_run_id} · This contribution is now read-only.</Text></View></View> : null}
              {!latestUsage && submission.status === "used" ? <Text style={styles.readOnlyText}>Used for AI learning · Read-only</Text> : null}
            </Card>;
          })}

          <View style={styles.moderationDivider}>
            <View><Text style={styles.sectionTitle}>Review queue</Text><Text style={styles.sectionSubtitle}>Approve feedback before it can become training data. Decisions apply to the whole submission.</Text></View>
            <Pressable accessibilityRole="button" onPress={loadModeration} hitSlop={8}><Ionicons name="refresh" size={21} color={colors.primary} /></Pressable>
          </View>
          {moderationMessage ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{moderationMessage}</Text></View> : null}
          {loadingModeration ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading pending submissions...</Text></View> : null}
          {moderationError ? <View style={styles.errorBox}><Text style={styles.errorText}>{moderationError}</Text><AppButton label="Try Again" variant="secondary" onPress={loadModeration} /></View> : null}
          {!loadingModeration && !moderationError && moderationSubmissions.length === 0 ? <Card><EmptyState icon="shield-checkmark-outline" title="Moderation queue is clear" message="There are no pending annotation submissions to review." /></Card> : null}

          {!loadingModeration && moderationSubmissions.map((detail) => (
            <Card key={detail.submission.id}>
              <View style={styles.moderationHeader}>
                <View><Text style={styles.detectionLabel}>Submission #{detail.submission.id}</Text><Text style={styles.detectionMeta}>Scan #{detail.submission.scan_id} · {new Date(detail.submission.created_at).toLocaleString("en-GB")}</Text></View>
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
                    <View style={styles.annotationTitleRow}><Text style={styles.annotationTitle}>{actionTitle(annotation.action)}</Text><Text style={styles.annotationId}>#{annotation.id}</Text></View>
                    {annotation.original_label ? <Text style={styles.annotationDetail}>Original label: <Text style={styles.annotationValue}>{annotation.original_label}</Text></Text> : null}
                    {annotation.final_label ? <Text style={styles.annotationDetail}>Final label: <Text style={styles.annotationValue}>{annotation.final_label}</Text></Text> : null}
                    <Text style={styles.annotationDetail}>Original box: <Text style={styles.annotationValue}>{formatAnnotationBox(annotation, "original")}</Text></Text>
                    <Text style={styles.annotationDetail}>Final box: <Text style={styles.annotationValue}>{formatAnnotationBox(annotation, "final")}</Text></Text>
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
            <View><Text style={styles.sectionTitle}>AI Progress</Text><Text style={styles.sectionSubtitle}>See the live model, real evaluation results, and how contributions are being used.</Text></View>
            <Pressable accessibilityRole="button" onPress={loadProgress} hitSlop={8}><Ionicons name="refresh" size={21} color={colors.primary} /></Pressable>
          </View>
          {loadingProgress ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading model progress...</Text></View> : null}
          {progressError ? <View style={styles.errorBox}><Text style={styles.errorText}>{progressError}</Text><AppButton label="Try Again" variant="secondary" onPress={loadProgress} /></View> : null}
          {!loadingProgress && progressStats ? <>
            <Card>
              <Text style={styles.sectionTitle}>Improve the model</Text>
              <Text style={styles.sectionSubtitle}>Build a new model from the base dataset and approved corrections. The model in use never changes automatically.</Text>
              {lifecycleMessage ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{lifecycleMessage}</Text></View> : null}
              {lifecycleError ? <View style={styles.errorBox}><Text style={styles.errorText}>{lifecycleError}</Text></View> : null}
              {lifecycleJob && lifecycleAction ? <View style={styles.jobStatus}><ActivityIndicator color={colors.primary} /><View style={styles.detectionCopy}><Text style={styles.jobTitle}>{lifecycleAction}</Text><Text style={styles.jobMeta}>{lifecyclePhaseLabel(lifecycleJob)}</Text></View></View> : null}
              <View style={styles.lifecycleActions}>
                <AppButton label="Train New Model" icon="school-outline" loading={lifecycleAction === "Train New Model"} disabled={Boolean(lifecycleAction) || !progressStats.actions.can_train} onPress={() => runLongLifecycleAction("Train New Model", startCandidateTraining)} />
                {progressStats.latest_candidate && (!progressStats.comparison || progressStats.promotion_evaluation.stale) ? <AppButton label="Compare Models" icon="analytics-outline" variant="secondary" loading={lifecycleAction === "Compare Models"} disabled={Boolean(lifecycleAction) || !progressStats.actions.can_compare} onPress={() => runLongLifecycleAction("Compare Models", () => startCandidateComparison(progressStats.latest_candidate!.version))} /> : null}
                <AppButton label="Use New Model" icon="rocket-outline" variant="secondary" loading={lifecycleAction === "Promote Candidate"} disabled={Boolean(lifecycleAction) || !progressStats.actions.can_promote} onPress={confirmPromotion} />
              </View>
              {!progressStats.actions.can_train ? <Text style={styles.actionHint}>Approve at least one contribution before training.</Text> : null}
              {!progressStats.latest_candidate ? <Text style={styles.actionHint}>Train a candidate before comparing or promoting.</Text> : null}
              {progressStats.latest_candidate && (!progressStats.comparison || progressStats.promotion_evaluation.stale) ? <Text style={styles.actionHint}>Compare the candidate with the current active model before promotion.</Text> : null}
              <View style={styles.rollbackSection}>
                <Text style={styles.modelRole}>ROLLBACK OPTIONS</Text>
                {progressStats.archived_models.length ? progressStats.archived_models.map((model) => <View key={model.id} style={styles.rollbackRow}><View style={styles.detectionCopy}><Text style={styles.modelVersion}>{model.version}</Text><Text style={styles.trainingMeta}>Archived · {new Date(model.created_at).toLocaleDateString("en-GB")}</Text></View><AppButton label="Rollback" icon="arrow-undo-outline" variant="danger" disabled={Boolean(lifecycleAction)} onPress={() => confirmRollback(model.version)} /></View>) : <Text style={styles.actionHint}>No archived model is available for rollback.</Text>}
              </View>
            </Card>
            <Card>
              <Text style={styles.sectionTitle}>Current and new model</Text>
              <Text style={styles.sectionSubtitle}>See which model is being used now and whether a newly trained model is ready.</Text>
              <View style={styles.modelRow}>
                <View style={styles.modelIcon}><Ionicons name="radio-button-on" size={22} color={colors.successFg} /></View>
                <View style={styles.detectionCopy}><Text style={styles.modelRole}>CURRENT MODEL</Text><Text style={styles.modelVersion}>{progressStats.active_model.version}</Text></View>
                <StatusBadge label="IN USE" tone="success" />
              </View>
              {progressStats.latest_candidate ? <View style={styles.modelRow}>
                <View style={styles.modelIcon}><Ionicons name="flask-outline" size={22} color={colors.primary} /></View>
                <View style={styles.detectionCopy}><Text style={styles.modelRole}>NEW MODEL</Text><Text style={styles.modelVersion}>{progressStats.latest_candidate.version}</Text></View>
                <StatusBadge label="READY TO REVIEW" tone="info" />
              </View> : <View style={styles.lifecycleEmpty}><Ionicons name="checkmark-circle-outline" size={20} color={colors.textMuted} /><Text style={styles.lifecycleEmptyText}>No candidate model is waiting for evaluation.</Text></View>}
            </Card>

            {progressStats.comparison && progressStats.latest_candidate ? <Card>
              <View style={styles.comparisonHeading}>
                <View style={styles.detectionCopy}><Text style={styles.sectionTitle}>Candidate {progressStats.latest_candidate.version}</Text><Text style={styles.sectionSubtitle}>Both models were tested on the same images from {progressStats.comparison.dataset_version}.</Text></View>
                <StatusBadge label={progressStats.promotion_evaluation.eligible ? "ELIGIBLE" : "NOT ELIGIBLE"} tone={progressStats.promotion_evaluation.eligible ? "success" : "warning"} />
              </View>
              {progressStats.promotion_evaluation.mode === "expanded_classes" ? <>
                <Text style={styles.modelRole}>ADDS {progressStats.comparison.class_comparison.added_classes.length} PRODUCTS</Text>
                {progressStats.comparison.class_comparison.added_classes.map((name) => <Text key={name} style={styles.comparisonSummary}>+ {name}</Text>)}
                {progressStats.comparison.class_comparison.removed_classes.length ? <Text style={styles.comparisonSummary}>Removes: {progressStats.comparison.class_comparison.removed_classes.join(", ")}</Text> : null}
                <View style={styles.sharedComparison}>
                  <Text style={styles.sectionTitle}>Existing products</Text>
                  <View style={styles.metricHeader}><Text style={styles.metricName}>mAP50-95</Text><Text style={styles.metricNumber}>Active</Text><Text style={styles.metricNumber}>Candidate</Text><Text style={styles.metricDelta}>Change</Text></View>
                  <View style={styles.metricRow}>
                    <Text style={styles.metricName}>Shared classes</Text>
                    <Text style={styles.metricNumber}>{formatMetric(progressStats.comparison.shared_class_comparison.active_metrics?.map50_95)}</Text>
                    <Text style={styles.metricNumber}>{formatMetric(progressStats.comparison.shared_class_comparison.candidate_metrics?.map50_95)}</Text>
                    <Text style={styles.metricDelta}>{formatMetricDifference(progressStats.comparison.shared_class_comparison.metric_differences?.map50_95)}</Text>
                  </View>
                  <Text style={styles.comparisonSummary}>Allowed regression: {formatMetricDifference(-progressStats.promotion_evaluation.thresholds.max_shared_map50_95_regression)}</Text>
                </View>
                <View style={styles.sharedComparison}>
                  <Text style={styles.sectionTitle}>New products</Text>
                  <Text style={styles.comparisonSummary}>Aggregate mAP50-95: {formatMetric(progressStats.comparison.added_class_metrics.aggregate?.map50_95)}</Text>
                  {Object.entries(progressStats.comparison.added_class_metrics.per_class).map(([name, metrics]) => <Text key={name} style={styles.comparisonSummary}>{name}: {formatMetric(metrics.map50_95)}</Text>)}
                </View>
              </> : <>
                <View style={styles.metricHeader}><Text style={styles.metricName}>Metric</Text><Text style={styles.metricNumber}>Active</Text><Text style={styles.metricNumber}>Candidate</Text><Text style={styles.metricDelta}>Change</Text></View>
                {METRIC_ROWS.filter(({ key }) => key === "map50_95" || key === "map50").map(({ key, label }) => {
                  const difference = progressStats.comparison?.metric_differences[key];
                  return <View key={key} style={styles.metricRow}>
                    <Text style={styles.metricName}>{label}</Text>
                    <Text style={styles.metricNumber}>{formatMetric(progressStats.comparison?.active_metrics[key])}</Text>
                    <Text style={styles.metricNumber}>{formatMetric(progressStats.comparison?.candidate_metrics[key])}</Text>
                    <Text style={[styles.metricDelta, difference != null && difference > 0 ? styles.positiveDelta : difference != null && difference < 0 ? styles.negativeDelta : null]}>{formatMetricDifference(difference)}</Text>
                  </View>;
                })}
              </>}
              <View style={styles.sharedComparison}>
                <Text style={styles.sectionTitle}>Promotion</Text>
                <Text style={styles.comparisonSummary}>{progressStats.promotion_evaluation.eligible ? "Eligible" : "Not eligible"}</Text>
                {progressStats.promotion_evaluation.reasons.map((reason, index) => <Text key={`${reason.code}-${index}`} style={styles.actionHint}>{promotionReasonText(reason)}</Text>)}
              </View>
            </Card> : progressStats.latest_candidate ? <Card><EmptyState icon="analytics-outline" title="Comparison needed" message="Compare the new model with the current model on the same test images before using it." /></Card> : null}

            <View style={styles.progressGrid}>
              {[
                { label: "Approved contributions", value: progressStats.contributions.total_approved, tone: colors.successFg, background: colors.successBg },
                { label: "Used in training", value: progressStats.contributions.used_in_training, tone: colors.infoFg, background: colors.infoBg },
                { label: "Ready for next training", value: progressStats.contributions.approved_waiting, tone: colors.primary, background: colors.primarySoft },
              ].map((item) => <View key={item.label} style={[styles.progressMetric, { backgroundColor: item.background }]}><Text style={[styles.progressValue, { color: item.tone }]}>{item.value}</Text><Text style={styles.progressLabel}>{item.label}</Text></View>)}
            </View>
            <Card>
              <Text style={styles.sectionTitle}>Recent training</Text>
              <Text style={styles.sectionSubtitle}>The latest real training runs and the model produced by each successful run.</Text>
              {progressStats.training_history.length ? <View style={styles.trainingHistory}>{progressStats.training_history.map((run) => <View key={run.training_run_id} style={styles.trainingRow}>
                <View style={styles.trainingMarker}><Ionicons name={run.status === "completed" ? "checkmark" : run.status === "running" ? "hourglass-outline" : "close"} size={18} color={run.status === "completed" ? colors.successFg : run.status === "running" ? colors.warningFg : colors.danger} /></View>
                <View style={styles.detectionCopy}>
                  <Text style={styles.trainingModel}>{run.model_version || "No model produced"}</Text>
                  <Text style={styles.trainingMeta}>{run.dataset_version} · {new Date(run.ended_at || run.started_at).toLocaleString("en-GB")}</Text>
                </View>
                <StatusBadge label={run.status.toUpperCase()} tone={run.status === "completed" ? "success" : run.status === "running" ? "warning" : "danger"} />
              </View>)}</View> : <View style={styles.lifecycleEmpty}><Ionicons name="time-outline" size={20} color={colors.textMuted} /><Text style={styles.lifecycleEmptyText}>No training runs have been recorded yet.</Text></View>}
            </Card>
            <View style={styles.progressNote}><Ionicons name="information-circle-outline" size={19} color={colors.infoFg} /><Text style={styles.noteText}>All values come from stored annotations, training runs, and same-dataset model evaluations.</Text></View>
          </> : null}
        </View>
      )}

      <View style={styles.note}>
        <Ionicons name="information-circle-outline" size={19} color={colors.infoFg} />
        <Text style={styles.noteText}>Contributions are stored separately for review. Original YOLO detections remain unchanged.</Text>
      </View>

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
        <View style={styles.imageBackdrop}>
          <View style={styles.labelModal}>
            <View style={styles.imageHeader}>
              <View><Text style={styles.imageTitle}>Correct product label</Text><Text style={styles.imageSubtitle}>Original: {editDetection?.label}</Text></View>
              <Pressable accessibilityLabel="Close label editor" disabled={savingLabel} onPress={() => setEditDetection(null)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable>
            </View>
            <Text style={styles.inputLabel}>Final product label</Text>
            <TextInput value={finalLabel} onChangeText={(value) => { setFinalLabel(value); setLabelError(""); }} placeholder="Enter the correct label" autoCapitalize="sentences" autoFocus style={[styles.labelInput, labelError && styles.labelInputError]} />
            {matchingLabels.length ? <View style={styles.labelSuggestions}>{matchingLabels.map((item) => <Pressable key={item.id} onPress={() => { setFinalLabel(item.name); setLabelError(""); }} style={styles.labelSuggestion}><Ionicons name="cube-outline" size={17} color={colors.primary} /><Text style={styles.labelSuggestionText}>{item.name}</Text></Pressable>)}</View> : null}
            {labelError ? <Text style={styles.modalError}>{labelError}</Text> : null}
            <View style={styles.modalActions}>
              <AppButton label="Submit Correction" icon="checkmark" loading={savingLabel} onPress={saveRelabel} />
              <AppButton label="Cancel" variant="ghost" disabled={savingLabel} onPress={() => setEditDetection(null)} />
            </View>
          </View>
        </View>
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
        <View style={styles.imageBackdrop}>
          <View style={styles.labelModal}>
            <View style={styles.imageHeader}>
              <View><Text style={styles.imageTitle}>Edit pending label</Text><Text style={styles.imageSubtitle}>Original: {editContribution?.annotation.original_label}</Text></View>
              <Pressable accessibilityLabel="Close contribution editor" disabled={savingContribution} onPress={() => setEditContribution(null)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable>
            </View>
            <Text style={styles.inputLabel}>Final product label</Text>
            <TextInput value={contributionLabel} onChangeText={(value) => { setContributionLabel(value); setContributionEditError(""); }} placeholder="Enter the correct label" autoCapitalize="sentences" autoFocus style={[styles.labelInput, contributionEditError && styles.labelInputError]} />
            {matchingContributionLabels.length ? <View style={styles.labelSuggestions}>{matchingContributionLabels.map((item) => <Pressable key={item.id} onPress={() => { setContributionLabel(item.name); setContributionEditError(""); }} style={styles.labelSuggestion}><Ionicons name="cube-outline" size={17} color={colors.primary} /><Text style={styles.labelSuggestionText}>{item.name}</Text></Pressable>)}</View> : null}
            {contributionEditError ? <Text style={styles.modalError}>{contributionEditError}</Text> : null}
            <View style={styles.modalActions}>
              <AppButton label="Save Label" icon="checkmark" loading={savingContribution} onPress={saveContributionLabel} />
              <AppButton label="Cancel" variant="ghost" disabled={savingContribution} onPress={() => setEditContribution(null)} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={boxEditor !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => !savingBox && setBoxEditor(null)}>
        <View style={styles.imageBackdrop}>
          <View style={styles.boxEditorModal}>
            <View style={styles.imageHeader}>
              <View><Text style={styles.imageTitle}>Edit bounding box</Text><Text style={styles.imageSubtitle}>Drag the box to move it · Drag a corner to resize</Text></View>
              <Pressable accessibilityLabel="Close box editor" disabled={savingBox} onPress={() => setBoxEditor(null)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable>
            </View>
            {boxEditor ? <BoundingBoxEditor imageUri={getScanImageUrl(boxEditor.scanId)} imageWidth={boxEditor.imageWidth} imageHeight={boxEditor.imageHeight} box={boxEditor.box} label={boxEditor.label} onBoxChange={(box) => setBoxEditor((current) => current ? { ...current, box } : null)} /> : null}
            {boxEditor?.source === "add" ? <>
              <Text style={styles.inputLabel}>Product label</Text>
              <TextInput value={boxEditor.label} onChangeText={(label) => { setBoxError(""); setBoxEditor((current) => current ? { ...current, label } : null); }} placeholder="Enter the missed product label" autoCapitalize="sentences" style={[styles.labelInput, boxError && !boxEditor.label.trim() && styles.labelInputError]} />
              {matchingBoxLabels.length ? <View style={styles.labelSuggestions}>{matchingBoxLabels.map((item) => <Pressable key={item.id} onPress={() => { setBoxError(""); setBoxEditor((current) => current ? { ...current, label: item.name } : null); }} style={styles.labelSuggestion}><Ionicons name="cube-outline" size={17} color={colors.primary} /><Text style={styles.labelSuggestionText}>{item.name}</Text></Pressable>)}</View> : null}
            </> : null}
            {boxError ? <Text style={styles.modalError}>{boxError}</Text> : null}
            <View style={styles.boxEditorActions}>
              <View style={styles.detectionAction}><AppButton label={boxEditor?.source === "add" ? "Clear Box" : "Reset"} icon="refresh" variant="ghost" disabled={savingBox || !boxEditor?.box} onPress={() => setBoxEditor((current) => current ? { ...current, box: current.originalBox } : null)} /></View>
              <View style={styles.detectionAction}><AppButton label="Save Box" icon="checkmark" loading={savingBox} onPress={saveBoxCorrection} /></View>
            </View>
          </View>
        </View>
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
  tabText: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textAlign: "center" },
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
  filterChip: { minHeight: 38, paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  selectedFilterChip: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterText: { color: colors.textSecondary, fontWeight: "700", fontSize: 13 },
  selectedFilterText: { color: colors.primaryText },
  scanChip: { minWidth: 126, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md, gap: 3 },
  selectedScanChip: { backgroundColor: colors.primary, borderColor: colors.primary },
  scanChipTitle: { fontWeight: "800", color: colors.navy },
  scanChipMeta: { color: colors.textMuted, fontSize: 12 },
  selectedScanText: { color: colors.primaryText },
  errorBox: { gap: spacing.sm, backgroundColor: colors.dangerBg, padding: spacing.md, borderRadius: radius.lg },
  errorText: { color: colors.danger, textAlign: "center", fontWeight: "600" },
  detectionTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  contributionHeader: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  detectionIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  removeIcon: { backgroundColor: colors.dangerBg },
  detectionCopy: { flex: 1, gap: 3 },
  detectionLabel: { fontSize: 17, fontWeight: "800", color: colors.navy },
  detectionMeta: { color: colors.textMuted, fontSize: 12 },
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
  usedModelMeta: { color: colors.successFg, fontSize: 11, lineHeight: 16 },
  readOnlyText: { marginTop: spacing.sm, color: colors.textMuted, fontSize: 12, fontWeight: "600", textAlign: "center" },
  moderationDivider: { marginTop: spacing.xl, paddingTop: spacing.xl, borderTopWidth: 2, borderTopColor: colors.border, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.md },
  moderationHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, marginBottom: spacing.md },
  moderationImage: { width: "100%", height: 300, backgroundColor: colors.surfaceMuted, borderRadius: radius.lg },
  moderationAnnotations: { marginTop: spacing.md, gap: spacing.sm },
  moderationAnnotation: { backgroundColor: colors.surfaceMuted, borderRadius: radius.lg, padding: spacing.md, gap: 5 },
  annotationTitleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  annotationTitle: { color: colors.navy, fontWeight: "800", fontSize: 15 },
  annotationId: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  annotationDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  annotationValue: { color: colors.textSecondary, fontWeight: "700" },
  moderationActions: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, flexDirection: "row", gap: spacing.sm },
  progressGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  progressMetric: { width: "48%", minHeight: 112, borderRadius: radius.xl, padding: spacing.lg, justifyContent: "center", gap: spacing.xs },
  progressValue: { fontSize: 32, fontWeight: "900" },
  progressLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: "700", lineHeight: 18 },
  modelRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: spacing.md, marginTop: spacing.sm },
  modelIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  modelRole: { color: colors.textMuted, fontSize: 11, fontWeight: "800", letterSpacing: 0.7 },
  modelVersion: { color: colors.navy, fontSize: 14, fontWeight: "800", marginTop: 2 },
  lifecycleEmpty: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted },
  lifecycleEmptyText: { flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 18 },
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
  trainingHistory: { marginTop: spacing.md },
  trainingRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  trainingMarker: { width: 34, height: 34, borderRadius: 12, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  trainingModel: { color: colors.navy, fontSize: 13, fontWeight: "800" },
  trainingMeta: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  lifecycleActions: { gap: spacing.sm, marginTop: spacing.lg },
  actionHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  jobStatus: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.primarySoft, borderRadius: radius.lg, padding: spacing.md, marginTop: spacing.md },
  jobTitle: { color: colors.navy, fontWeight: "800", fontSize: 13 },
  jobMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  rollbackSection: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.lg, paddingTop: spacing.md },
  rollbackRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md },
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
  imageBackdrop: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.72)", alignItems: "center", justifyContent: "center", padding: spacing.lg },
  imageModal: { width: "100%", maxWidth: 520, backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md },
  imageHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  imageTitle: { ...typography.section, color: colors.navy },
  imageSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  scanImage: { width: "100%", height: 430, backgroundColor: colors.surfaceMuted, borderRadius: radius.lg },
  imageNote: { color: colors.textMuted, fontSize: 12, textAlign: "center" },
  labelModal: { width: "100%", maxWidth: 460, backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md },
  boxEditorModal: { width: "100%", maxWidth: 560, backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, gap: spacing.md },
  boxEditorActions: { flexDirection: "row", gap: spacing.sm },
  inputLabel: { color: colors.textSecondary, fontWeight: "700", fontSize: 13 },
  labelInput: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, paddingHorizontal: spacing.md, minHeight: 48, color: colors.textPrimary, backgroundColor: colors.surface },
  labelInputError: { borderColor: colors.danger },
  labelSuggestions: { gap: spacing.xs },
  labelSuggestion: { flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.primarySoft },
  labelSuggestionText: { color: colors.primary, fontWeight: "700" },
  modalError: { color: colors.danger, backgroundColor: colors.dangerBg, borderRadius: radius.md, padding: spacing.sm, fontWeight: "600" },
  modalActions: { gap: spacing.sm },
  confirmIcon: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.dangerBg, alignItems: "center", justifyContent: "center", alignSelf: "center" },
  confirmSuccessIcon: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.successBg, alignItems: "center", justifyContent: "center", alignSelf: "center" },
  confirmTitle: { ...typography.section, color: colors.navy, textAlign: "center" },
  confirmMessage: { ...typography.body, color: colors.textMuted, lineHeight: 22, textAlign: "center" },
  confirmLabel: { color: colors.navy, fontWeight: "800" },
});

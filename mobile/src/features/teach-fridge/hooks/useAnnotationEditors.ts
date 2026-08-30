import { useState } from "react";

import { createAnnotationSubmission, getAllInventory, getAuthenticatedImageSize, getScanImageUrl, updateAnnotationBox, updateAnnotationLabel } from "../../../services/api";
import type { DetectionItem, InventoryItem, RecentScan } from "../../../types/api";
import { areImageDimensionsCompatible, getMinimumAnnotationBoxSize } from "../../../utils/imageCoordinates";
import { detectionBox } from "../annotationUtils";
import type { BoxEditorTarget, Contribution } from "../types";

export function useAnnotationEditors({
  selectedScan,
  refreshScan,
  loadContributions,
  setSuggestionsError,
}: {
  selectedScan: RecentScan | null;
  refreshScan: (scan: RecentScan) => Promise<void>;
  loadContributions: () => Promise<void>;
  setSuggestionsError: (message: string) => void;
}) {
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

  async function loadInventoryLabels() {
    try {
      setInventoryLabels(await getAllInventory());
    } catch {
      setInventoryLabels([]);
    }
  }

  async function openLabelEditor(detection: DetectionItem) {
    setEditDetection(detection);
    setFinalLabel(pendingRelabels[detection.id]?.finalLabel || detection.label);
    setLabelError("");
    await loadInventoryLabels();
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
      const response = await createAnnotationSubmission(selectedScan.id, [{ action: "RELABEL", source_detection_id: editDetection.id, final_label: correctedLabel }]);
      setPendingRelabels((current) => ({ ...current, [editDetection.id]: { finalLabel: correctedLabel, submissionId: response.submission.id } }));
      setSubmissionMessage(`${editDetection.label} → ${correctedLabel} was submitted for review.`);
      setEditDetection(null);
      await refreshScan(selectedScan);
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
      const response = await createAnnotationSubmission(selectedScan.id, [{ action: "REMOVE", source_detection_id: detection.id }]);
      setPendingRemovals((current) => ({ ...current, [detection.id]: response.submission.id }));
      setSubmissionMessage(`${detection.label} was submitted as a false positive and is pending review.`);
      setRemoveDetection(null);
      await refreshScan(selectedScan);
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
      const response = await createAnnotationSubmission(selectedScan.id, [{ action: "CONFIRM", source_detection_id: detection.id }]);
      setPendingConfirms((current) => ({ ...current, [detection.id]: response.submission.id }));
      setSubmissionMessage(`${detection.label} was confirmed and submitted for review.`);
      setConfirmDetection(null);
      await refreshScan(selectedScan);
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
    await loadInventoryLabels();
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

  function openSuggestionBoxEditor(detection: DetectionItem) {
    const originalBox = detectionBox(detection);
    if (!selectedScan || !originalBox) return;
    setBoxError("");
    setBoxEditor({ source: "suggestion", scanId: selectedScan.id, imageWidth: selectedScan.image_width, imageHeight: selectedScan.image_height, detectionId: detection.id, label: detection.label, originalBox, box: originalBox });
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
    const { width, height } = await getAuthenticatedImageSize(imageUrl).catch(() => {
      throw new Error(`The original image for scan #${scan.id} could not be loaded.`);
    });
    if (width <= 0 || height <= 0) {
      throw new Error(`Scan #${scan.id} image dimensions could not be read.`);
    }
    if (!areImageDimensionsCompatible(scan.image_width, scan.image_height, width, height)) {
      throw new Error(`Scan #${scan.id} image geometry is incompatible: stored ${scan.image_width} × ${scan.image_height}, decoded ${width} × ${height}.`);
    }
    setBoxError("");
    setBoxEditor({ source: "add", scanId: scan.id, imageWidth: scan.image_width, imageHeight: scan.image_height, label: "", originalBox: null, box: null });
    await loadInventoryLabels();
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
    setBoxEditor({ source: "contribution", scanId: submission.scan_id, imageWidth: submission.image_width, imageHeight: submission.image_height, detectionId: annotation.source_detection_id, annotationId: annotation.id, label: annotation.final_label || annotation.original_label || "Detection", originalBox, box });
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
        const response = await createAnnotationSubmission(boxEditor.scanId, [{ action: "ADJUST_BOX", source_detection_id: detectionId, final_x1: savedBox.x1, final_y1: savedBox.y1, final_x2: savedBox.x2, final_y2: savedBox.y2 }]);
        setPendingBoxes((current) => ({ ...current, [detectionId]: response.submission.id }));
        setSubmissionMessage(`${boxEditor.label} box adjustment was submitted and is pending review.`);
      } else if (boxEditor.source === "add") {
        await createAnnotationSubmission(boxEditor.scanId, [{ action: "ADD", source_detection_id: null, final_label: label, final_x1: savedBox.x1, final_y1: savedBox.y1, final_x2: savedBox.x2, final_y2: savedBox.y2 }]);
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

  return {
    imageDetection, setImageDetection, editDetection, setEditDetection, finalLabel, setFinalLabel, inventoryLabels,
    savingLabel, labelError, setLabelError, submissionMessage, pendingRelabels,
    removeDetection, setRemoveDetection, removingDetectionId, removeError, setRemoveError, pendingRemovals,
    contributionImage, setContributionImage, editContribution, setEditContribution, contributionLabel, setContributionLabel,
    contributionEditError, setContributionEditError, savingContribution, contributionMessage,
    boxEditor, setBoxEditor, savingBox, boxError, setBoxError, pendingBoxes,
    confirmDetection, setConfirmDetection, confirmingDetectionId, confirmError, setConfirmError, pendingConfirms,
    openLabelEditor, saveRelabel, confirmRemoveDetection, submitDetectionConfirmation, openContributionEditor,
    saveContributionLabel, openSuggestionBoxEditor, openAddBoxEditor, openAddBoxEditorForScan,
    openContributionBoxEditor, saveBoxCorrection,
  };
}

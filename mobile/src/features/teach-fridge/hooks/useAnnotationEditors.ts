import { useCallback, useEffect, useState } from "react";

import {
  createAnnotationSubmission,
  getAllInventory,
  getAuthenticatedImageSize,
  getMyAnnotationSubmission,
  getMyAnnotationSubmissions,
  getScanImageUrl,
  updateAnnotationBox,
  updateAnnotationLabel,
} from "../../../services/api";
import type {
  DetectionItem,
  InventoryItem,
  RecentScan,
} from "../../../types/api";
import type { ImageBoundingBox } from "../../../utils/imageCoordinates";
import {
  areImageDimensionsCompatible,
  getMinimumAnnotationBoxSize,
} from "../../../utils/imageCoordinates";
import {
  combineAnnotationGroup,
  contributionDetection,
  detectionBox,
} from "../annotationUtils";
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
  const [imageDetection, setImageDetectionState] = useState<DetectionItem | null>(null);
  const [editDetection, setEditDetection] = useState<DetectionItem | null>(null);
  const [finalLabel, setFinalLabel] = useState("");
  const [inventoryLabels, setInventoryLabels] = useState<InventoryItem[]>([]);
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelError, setLabelError] = useState("");
  const [submissionMessage, setSubmissionMessage] = useState("");
  const [pendingRelabels, setPendingRelabels] = useState<
    Record<number, { finalLabel: string; submissionId: number }>
  >({});
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
  const [pendingBoxValues, setPendingBoxValues] = useState<
    Record<number, ImageBoundingBox>
  >({});
  const [confirmDetection, setConfirmDetection] = useState<DetectionItem | null>(null);
  const [confirmingDetectionId, setConfirmingDetectionId] = useState<number | null>(null);
  const [confirmError, setConfirmError] = useState("");
  const [pendingConfirms, setPendingConfirms] = useState<Record<number, number>>({});

  useEffect(() => {
    const scanId = selectedScan?.id;

    setPendingRelabels({});
    setPendingRemovals({});
    setPendingBoxes({});
    setPendingBoxValues({});
    setPendingConfirms({});

    if (!scanId) return;

    let active = true;

    (async () => {
      try {
        const submissions = await getMyAnnotationSubmissions("pending");
        const matching = submissions.filter(
          (submission) => submission.scan_id === scanId,
        );
        const details = await Promise.all(
          matching.map((submission) =>
            getMyAnnotationSubmission(submission.id),
          ),
        );

        if (!active) return;

        const relabels: Record<
          number,
          { finalLabel: string; submissionId: number }
        > = {};
        const removals: Record<number, number> = {};
        const boxes: Record<number, number> = {};
        const boxValues: Record<number, ImageBoundingBox> = {};
        const confirms: Record<number, number> = {};

        details.forEach((detail) => {
          detail.annotations.forEach((annotation) => {
            if (annotation.source_detection_id == null) return;
            const detectionId = annotation.source_detection_id;

            if (annotation.action === "RELABEL" && annotation.final_label) {
              relabels[detectionId] = {
                finalLabel: annotation.final_label,
                submissionId: detail.submission.id,
              };
            } else if (annotation.action === "REMOVE") {
              removals[detectionId] = detail.submission.id;
            } else if (
              annotation.action === "ADJUST_BOX"
              && annotation.final_x1 != null
              && annotation.final_y1 != null
              && annotation.final_x2 != null
              && annotation.final_y2 != null
            ) {
              boxes[detectionId] = detail.submission.id;
              boxValues[detectionId] = {
                x1: annotation.final_x1,
                y1: annotation.final_y1,
                x2: annotation.final_x2,
                y2: annotation.final_y2,
              };
            } else if (annotation.action === "CONFIRM") {
              confirms[detectionId] = detail.submission.id;
            }
          });
        });

        setPendingRelabels(relabels);
        setPendingRemovals(removals);
        setPendingBoxes(boxes);
        setPendingBoxValues(boxValues);
        setPendingConfirms(confirms);
      } catch {
        // Pending-state hydration is convenience UI. Core correction flows
        // remain usable even if this refresh cannot be loaded.
      }
    })();

    return () => {
      active = false;
    };
  }, [selectedScan?.id]);

  const effectiveDetection = useCallback(
    (detection: DetectionItem): DetectionItem => {
      const relabel = pendingRelabels[detection.id];
      const box = pendingBoxValues[detection.id];
      return {
        ...detection,
        label: relabel?.finalLabel || detection.label,
        x1: box?.x1 ?? detection.x1,
        y1: box?.y1 ?? detection.y1,
        x2: box?.x2 ?? detection.x2,
        y2: box?.y2 ?? detection.y2,
      };
    },
    [pendingBoxValues, pendingRelabels],
  );

  const setImageDetection = useCallback(
    (detection: DetectionItem | null) => {
      setImageDetectionState(
        detection ? effectiveDetection(detection) : null,
      );
    },
    [effectiveDetection],
  );

  useEffect(() => {
    setImageDetectionState((current) =>
      current ? effectiveDetection(current) : current,
    );
  }, [effectiveDetection]);

  async function loadInventoryLabels() {
    try {
      setInventoryLabels(await getAllInventory());
    } catch {
      setInventoryLabels([]);
    }
  }

  async function openLabelEditor(detection: DetectionItem) {
    const effective = effectiveDetection(detection);
    setEditDetection(detection);
    setFinalLabel(effective.label);
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
      const response = await createAnnotationSubmission(selectedScan.id, [
        {
          action: "RELABEL",
          source_detection_id: editDetection.id,
          final_label: correctedLabel,
        },
      ]);

      setPendingRelabels((current) => ({
        ...current,
        [editDetection.id]: {
          finalLabel: correctedLabel,
          submissionId: response.submission.id,
        },
      }));
      setSubmissionMessage(
        `${editDetection.label} → ${correctedLabel} was submitted for review.`,
      );
      setEditDetection(null);
      await refreshScan(selectedScan);
    } catch (caught) {
      setLabelError(
        caught instanceof Error
          ? caught.message
          : "Could not submit the corrected label.",
      );
    } finally {
      setSavingLabel(false);
    }
  }

  async function confirmRemoveDetection() {
    if (
      !removeDetection
      || !selectedScan
      || removingDetectionId !== null
      || pendingRemovals[removeDetection.id]
    ) return;

    const detection = removeDetection;
    setRemovingDetectionId(detection.id);
    setRemoveError("");

    try {
      const response = await createAnnotationSubmission(selectedScan.id, [
        {
          action: "REMOVE",
          source_detection_id: detection.id,
        },
      ]);
      setPendingRemovals((current) => ({
        ...current,
        [detection.id]: response.submission.id,
      }));
      setSubmissionMessage(
        `${detection.label} was submitted as a false positive and is pending review.`,
      );
      setRemoveDetection(null);
      await refreshScan(selectedScan);
    } catch (caught) {
      setRemoveError(
        caught instanceof Error
          ? caught.message
          : "Could not submit the false-positive report.",
      );
    } finally {
      setRemovingDetectionId(null);
    }
  }

  async function submitDetectionConfirmation() {
    if (
      !confirmDetection
      || !selectedScan
      || confirmingDetectionId !== null
      || pendingConfirms[confirmDetection.id]
      || pendingRelabels[confirmDetection.id]
      || pendingRemovals[confirmDetection.id]
      || pendingBoxes[confirmDetection.id]
    ) return;

    const detection = confirmDetection;
    setConfirmingDetectionId(detection.id);
    setConfirmError("");

    try {
      const response = await createAnnotationSubmission(selectedScan.id, [
        {
          action: "CONFIRM",
          source_detection_id: detection.id,
        },
      ]);
      setPendingConfirms((current) => ({
        ...current,
        [detection.id]: response.submission.id,
      }));
      setSubmissionMessage(
        `${detection.label} was confirmed and submitted for review.`,
      );
      setConfirmDetection(null);
      await refreshScan(selectedScan);
    } catch (caught) {
      setConfirmError(
        caught instanceof Error
          ? caught.message
          : "Could not confirm this detection.",
      );
    } finally {
      setConfirmingDetectionId(null);
    }
  }

  async function openContributionEditor(contribution: Contribution) {
    const effective = combineAnnotationGroup(contribution.annotations);
    setEditContribution(contribution);
    setContributionLabel(effective.final_label || "");
    setContributionEditError("");
    await loadInventoryLabels();
  }

  async function saveContributionLabel() {
    const correctedLabel = contributionLabel.trim();
    if (!editContribution || editContribution.submission.status !== "pending") {
      return;
    }

    const labelAnnotation = editContribution.annotations.find((annotation) =>
      ["RELABEL", "ADD"].includes(annotation.action),
    );
    if (!labelAnnotation) return;

    if (!correctedLabel) {
      setContributionEditError("Enter a product label before saving.");
      return;
    }

    setSavingContribution(true);
    setContributionEditError("");

    try {
      await updateAnnotationLabel(labelAnnotation.id, correctedLabel);
      if (labelAnnotation.source_detection_id != null) {
        setPendingRelabels((current) => ({
          ...current,
          [labelAnnotation.source_detection_id!]: {
            finalLabel: correctedLabel,
            submissionId: editContribution.submission.id,
          },
        }));
      }
      setEditContribution(null);
      setContributionMessage("Pending label correction updated successfully.");
      await loadContributions();
    } catch (caught) {
      setContributionEditError(
        caught instanceof Error
          ? caught.message
          : "Could not update the label correction.",
      );
    } finally {
      setSavingContribution(false);
    }
  }

  function openSuggestionBoxEditor(detection: DetectionItem) {
    const effective = effectiveDetection(detection);
    const originalBox = detectionBox(effective);
    if (!selectedScan || !originalBox) return;

    setBoxError("");
    setBoxEditor({
      source: "suggestion",
      scanId: selectedScan.id,
      imageWidth: selectedScan.image_width,
      imageHeight: selectedScan.image_height,
      detectionId: detection.id,
      label: effective.label,
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
      setSuggestionsError(
        caught instanceof Error
          ? caught.message
          : "Could not open the original scan image.",
      );
    }
  }

  async function openAddBoxEditorForScan(scan: RecentScan) {
    if (
      !Number.isFinite(scan.image_width)
      || !Number.isFinite(scan.image_height)
      || scan.image_width <= 0
      || scan.image_height <= 0
    ) {
      throw new Error(
        `Scan #${scan.id} does not have valid image dimensions.`,
      );
    }

    const imageUrl = getScanImageUrl(scan.id);
    const { width, height } = await getAuthenticatedImageSize(imageUrl).catch(
      () => {
        throw new Error(
          `The original image for scan #${scan.id} could not be loaded.`,
        );
      },
    );

    if (width <= 0 || height <= 0) {
      throw new Error(
        `Scan #${scan.id} image dimensions could not be read.`,
      );
    }

    if (
      !areImageDimensionsCompatible(
        scan.image_width,
        scan.image_height,
        width,
        height,
      )
    ) {
      throw new Error(
        `Scan #${scan.id} image geometry is incompatible: stored ${scan.image_width} × ${scan.image_height}, decoded ${width} × ${height}.`,
      );
    }

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
    await loadInventoryLabels();
  }

  function openContributionBoxEditor(contribution: Contribution) {
    const boxAnnotation = contribution.annotations.find(
      (annotation) => annotation.action === "ADJUST_BOX",
    );
    if (
      !boxAnnotation
      || contribution.submission.status !== "pending"
      || boxAnnotation.source_detection_id == null
    ) return;

    const effective = contributionDetection(contribution);
    const originalValues = [
      boxAnnotation.original_x1,
      boxAnnotation.original_y1,
      boxAnnotation.original_x2,
      boxAnnotation.original_y2,
    ];
    if (originalValues.some((value) => value == null)) return;

    const originalBox = {
      x1: originalValues[0]!,
      y1: originalValues[1]!,
      x2: originalValues[2]!,
      y2: originalValues[3]!,
    };
    const box = detectionBox(effective);
    if (!box) return;

    setBoxError("");
    setBoxEditor({
      source: "contribution",
      scanId: contribution.submission.scan_id,
      imageWidth: contribution.submission.image_width,
      imageHeight: contribution.submission.image_height,
      detectionId: boxAnnotation.source_detection_id,
      annotationId: boxAnnotation.id,
      label: effective.label,
      originalBox,
      box,
    });
  }

  async function saveBoxCorrection() {
    if (!boxEditor) return;
    const { box } = boxEditor;

    if (!box) {
      setBoxError(
        "Draw a bounding box around the missed product before saving.",
      );
      return;
    }

    const label = boxEditor.label.trim();
    if (boxEditor.source === "add" && !label) {
      setBoxError("Choose or enter the product label before saving.");
      return;
    }

    if (
      box.x1 < 0
      || box.y1 < 0
      || box.x2 > boxEditor.imageWidth
      || box.y2 > boxEditor.imageHeight
      || box.x2 <= box.x1
      || box.y2 <= box.y1
    ) {
      setBoxError(
        "The box must have a positive size and stay inside the image.",
      );
      return;
    }

    const minimumSize = getMinimumAnnotationBoxSize(
      boxEditor.imageWidth,
      boxEditor.imageHeight,
    );
    if (
      boxEditor.source === "add"
      && (
        box.x2 - box.x1 < minimumSize
        || box.y2 - box.y1 < minimumSize
      )
    ) {
      setBoxError(
        "The box is too small. Draw a clear box around the whole product.",
      );
      return;
    }

    const savedBox = {
      x1: Number(box.x1.toFixed(2)),
      y1: Number(box.y1.toFixed(2)),
      x2: Number(box.x2.toFixed(2)),
      y2: Number(box.y2.toFixed(2)),
    };

    setSavingBox(true);
    setBoxError("");

    try {
      if (boxEditor.source === "suggestion") {
        if (boxEditor.detectionId == null) {
          throw new Error("Source detection is missing.");
        }

        const detectionId = boxEditor.detectionId;
        const response = await createAnnotationSubmission(boxEditor.scanId, [
          {
            action: "ADJUST_BOX",
            source_detection_id: detectionId,
            final_x1: savedBox.x1,
            final_y1: savedBox.y1,
            final_x2: savedBox.x2,
            final_y2: savedBox.y2,
          },
        ]);

        setPendingBoxes((current) => ({
          ...current,
          [detectionId]: response.submission.id,
        }));
        setPendingBoxValues((current) => ({
          ...current,
          [detectionId]: savedBox,
        }));
        setSubmissionMessage(
          `${boxEditor.label} box adjustment was submitted and is pending review.`,
        );
      } else if (boxEditor.source === "add") {
        await createAnnotationSubmission(boxEditor.scanId, [
          {
            action: "ADD",
            source_detection_id: null,
            final_label: label,
            final_x1: savedBox.x1,
            final_y1: savedBox.y1,
            final_x2: savedBox.x2,
            final_y2: savedBox.y2,
          },
        ]);
        setSubmissionMessage(
          `${label} was added as a missed product and is pending review.`,
        );
      } else if (boxEditor.annotationId != null) {
        await updateAnnotationBox(boxEditor.annotationId, savedBox);
        if (boxEditor.detectionId != null) {
          setPendingBoxValues((current) => ({
            ...current,
            [boxEditor.detectionId!]: savedBox,
          }));
        }
        setContributionMessage(
          "Pending bounding-box correction updated successfully.",
        );
        await loadContributions();
      }

      setBoxEditor(null);
    } catch (caught) {
      setBoxError(
        caught instanceof Error
          ? caught.message
          : "Could not save the bounding-box correction.",
      );
    } finally {
      setSavingBox(false);
    }
  }

  return {
    imageDetection,
    setImageDetection,
    editDetection,
    setEditDetection,
    finalLabel,
    setFinalLabel,
    inventoryLabels,
    savingLabel,
    labelError,
    setLabelError,
    submissionMessage,
    pendingRelabels,
    removeDetection,
    setRemoveDetection,
    removingDetectionId,
    removeError,
    setRemoveError,
    pendingRemovals,
    contributionImage,
    setContributionImage,
    editContribution,
    setEditContribution,
    contributionLabel,
    setContributionLabel,
    contributionEditError,
    setContributionEditError,
    savingContribution,
    contributionMessage,
    boxEditor,
    setBoxEditor,
    savingBox,
    boxError,
    setBoxError,
    pendingBoxes,
    pendingBoxValues,
    confirmDetection,
    setConfirmDetection,
    confirmingDetectionId,
    confirmError,
    setConfirmError,
    pendingConfirms,
    effectiveDetection,
    openLabelEditor,
    saveRelabel,
    confirmRemoveDetection,
    submitDetectionConfirmation,
    openContributionEditor,
    saveContributionLabel,
    openSuggestionBoxEditor,
    openAddBoxEditor,
    openAddBoxEditorForScan,
    openContributionBoxEditor,
    saveBoxCorrection,
  };
}

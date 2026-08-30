import type { AnnotationItem, DetectionItem } from "../../types/api";
import { parseApiDate } from "../../utils/date";
import type { ImageBoundingBox } from "../../utils/imageCoordinates";
import type { Contribution } from "./types";

export function actionTitle(action: AnnotationItem["action"]) {
  return action === "RELABEL"
    ? "Label correction"
    : action === "REMOVE"
      ? "False positive"
      : action === "ADJUST_BOX"
        ? "Box adjustment"
        : action === "ADD"
          ? "Missed product"
          : "Confirmed detection";
}

export function contributionProductLabel(annotation: AnnotationItem) {
  return annotation.final_label?.trim()
    || annotation.original_label?.trim()
    || "Unlabeled product";
}

export function groupAnnotationsForDisplay(annotations: AnnotationItem[]) {
  const groups = new Map<string, AnnotationItem[]>();

  annotations.forEach((annotation) => {
    const key = annotation.source_detection_id != null
      ? `source:${annotation.source_detection_id}`
      : `annotation:${annotation.id}`;
    groups.set(key, [...(groups.get(key) || []), annotation]);
  });

  return [...groups.values()];
}

export function combineAnnotationGroup(annotations: AnnotationItem[]): AnnotationItem {
  if (!annotations.length) {
    throw new Error("Cannot combine an empty annotation group.");
  }

  const sorted = [...annotations].sort((left, right) => left.id - right.id);
  const relabel = [...sorted].reverse().find((item) => item.action === "RELABEL");
  const box = [...sorted].reverse().find((item) => item.action === "ADJUST_BOX");
  const add = [...sorted].reverse().find((item) => item.action === "ADD");
  const representative = relabel || box || add || sorted[sorted.length - 1];
  const original = sorted.find((item) => item.original_label || item.original_x1 != null) || representative;

  const finalBoxSource = box || add || relabel || representative;
  const trainingUsages = sorted
    .flatMap((item) => item.training_usages || [])
    .sort((left, right) => parseApiDate(right.used_at).getTime() - parseApiDate(left.used_at).getTime());

  return {
    ...representative,
    original_label: original.original_label ?? representative.original_label,
    original_confidence: original.original_confidence ?? representative.original_confidence,
    original_x1: original.original_x1 ?? representative.original_x1,
    original_y1: original.original_y1 ?? representative.original_y1,
    original_x2: original.original_x2 ?? representative.original_x2,
    original_y2: original.original_y2 ?? representative.original_y2,
    final_label:
      relabel?.final_label
      ?? add?.final_label
      ?? box?.final_label
      ?? representative.final_label
      ?? original.original_label,
    final_x1: finalBoxSource.final_x1 ?? original.original_x1,
    final_y1: finalBoxSource.final_y1 ?? original.original_y1,
    final_x2: finalBoxSource.final_x2 ?? original.original_x2,
    final_y2: finalBoxSource.final_y2 ?? original.original_y2,
    training_usages: trainingUsages,
  };
}

export function annotationGroupActionTitle(annotations: AnnotationItem[]) {
  const actions = new Set(annotations.map((annotation) => annotation.action));
  if (actions.has("RELABEL") && actions.has("ADJUST_BOX")) {
    return "Label + area correction";
  }
  if (actions.has("ADD")) return "Missed product";
  if (actions.has("REMOVE")) return "False positive";
  if (actions.has("CONFIRM")) return "Confirmed detection";
  if (actions.has("RELABEL")) return "Label correction";
  if (actions.has("ADJUST_BOX")) return "Box adjustment";
  return annotations[0] ? actionTitle(annotations[0].action) : "Correction";
}

export function contributionActionTitle(contribution: Contribution) {
  return annotationGroupActionTitle(contribution.annotations);
}

export function contributionProductLabelForContribution(contribution: Contribution) {
  return contributionProductLabel(combineAnnotationGroup(contribution.annotations));
}

export function annotationDetection(annotation: AnnotationItem): DetectionItem {
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

export function contributionDetection(contribution: Contribution): DetectionItem {
  return annotationDetection(combineAnnotationGroup(contribution.annotations));
}

export function hasDrawableBox(
  detection: DetectionItem,
  imageWidth: number,
  imageHeight: number,
) {
  const { x1, y1, x2, y2 } = detection;
  if (![x1, y1, x2, y2, imageWidth, imageHeight].every(
    (value) => value != null && Number.isFinite(value),
  )) return false;
  return imageWidth > 0
    && imageHeight > 0
    && Math.min(imageWidth, x2!) > Math.max(0, x1!)
    && Math.min(imageHeight, y2!) > Math.max(0, y1!);
}

export function detectionBox(detection: DetectionItem): ImageBoundingBox | null {
  if (
    detection.x1 == null
    || detection.y1 == null
    || detection.x2 == null
    || detection.y2 == null
  ) return null;
  if (detection.x2 <= detection.x1 || detection.y2 <= detection.y1) return null;
  return {
    x1: detection.x1,
    y1: detection.y1,
    x2: detection.x2,
    y2: detection.y2,
  };
}

export function formatAnnotationBox(
  annotation: AnnotationItem,
  prefix: "original" | "final",
) {
  const values = prefix === "original"
    ? [
        annotation.original_x1,
        annotation.original_y1,
        annotation.original_x2,
        annotation.original_y2,
      ]
    : [
        annotation.final_x1,
        annotation.final_y1,
        annotation.final_x2,
        annotation.final_y2,
      ];
  if (values.some((value) => value == null)) return "None";
  return values.map((value) => Math.round(value!)).join(", ");
}

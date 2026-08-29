import type { AnnotationItem, DetectionItem } from "../../types/api";
import type { ImageBoundingBox } from "../../utils/imageCoordinates";
import type { Contribution } from "./types";

export function actionTitle(action: AnnotationItem["action"]) {
  return action === "RELABEL" ? "Label correction" : action === "REMOVE" ? "False positive" : action === "ADJUST_BOX" ? "Box adjustment" : action === "ADD" ? "Missed product" : "Confirmed detection";
}

export function contributionProductLabel(annotation: AnnotationItem) {
  return annotation.final_label?.trim() || annotation.original_label?.trim() || "Unlabeled product";
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

export function hasDrawableBox(detection: DetectionItem, imageWidth: number, imageHeight: number) {
  const { x1, y1, x2, y2 } = detection;
  if (![x1, y1, x2, y2, imageWidth, imageHeight].every((value) => value != null && Number.isFinite(value))) return false;
  return imageWidth > 0 && imageHeight > 0
    && Math.min(imageWidth, x2!) > Math.max(0, x1!)
    && Math.min(imageHeight, y2!) > Math.max(0, y1!);
}

export function detectionBox(detection: DetectionItem): ImageBoundingBox | null {
  if (detection.x1 == null || detection.y1 == null || detection.x2 == null || detection.y2 == null) return null;
  if (detection.x2 <= detection.x1 || detection.y2 <= detection.y1) return null;
  return { x1: detection.x1, y1: detection.y1, x2: detection.x2, y2: detection.y2 };
}

export function formatAnnotationBox(annotation: AnnotationItem, prefix: "original" | "final") {
  const values = prefix === "original"
    ? [annotation.original_x1, annotation.original_y1, annotation.original_x2, annotation.original_y2]
    : [annotation.final_x1, annotation.final_y1, annotation.final_x2, annotation.final_y2];
  if (values.some((value) => value == null)) return "None";
  return values.map((value) => Math.round(value!)).join(", ");
}

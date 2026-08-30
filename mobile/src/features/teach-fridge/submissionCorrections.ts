import type {
  AnnotationItem,
  AnnotationSubmissionDetail,
  DetectionItem,
} from "../../types/api";
import type { ImageBoundingBox } from "../../utils/imageCoordinates";

export type SubmissionCorrectionObject = {
  key: string;
  primaryAnnotationId: number;
  annotationIds: number[];
  annotations: AnnotationItem[];
  sourceDetectionId: number | null;
  originalLabel: string;
  finalLabel: string | null;
  displayLabel: string;
  originalBox: ImageBoundingBox | null;
  finalBox: ImageBoundingBox | null;
  detection: DetectionItem | null;
  kind:
    | "CONFIRM"
    | "RELABEL"
    | "ADJUST_BOX"
    | "RELABEL_AND_BOX"
    | "ADD"
    | "REMOVE";
};

function annotationBox(
  annotation: AnnotationItem,
  prefix: "original" | "final",
): ImageBoundingBox | null {
  const x1 =
    prefix === "original" ? annotation.original_x1 : annotation.final_x1;
  const y1 =
    prefix === "original" ? annotation.original_y1 : annotation.final_y1;
  const x2 =
    prefix === "original" ? annotation.original_x2 : annotation.final_x2;
  const y2 =
    prefix === "original" ? annotation.original_y2 : annotation.final_y2;

  if (
    x1 == null ||
    y1 == null ||
    x2 == null ||
    y2 == null ||
    ![x1, y1, x2, y2].every(Number.isFinite) ||
    x2 <= x1 ||
    y2 <= y1
  ) {
    return null;
  }

  return { x1, y1, x2, y2 };
}

function firstBox(
  annotations: AnnotationItem[],
  prefix: "original" | "final",
): ImageBoundingBox | null {
  for (const annotation of annotations) {
    const box = annotationBox(annotation, prefix);
    if (box) return box;
  }
  return null;
}

export function buildSubmissionCorrectionObjects(
  detail: AnnotationSubmissionDetail,
): SubmissionCorrectionObject[] {
  const grouped = new Map<string, AnnotationItem[]>();

  detail.annotations.forEach((annotation) => {
    const key =
      annotation.action === "ADD"
        ? `add:${annotation.id}`
        : annotation.source_detection_id != null
          ? `source:${annotation.source_detection_id}`
          : `annotation:${annotation.id}`;

    grouped.set(key, [...(grouped.get(key) || []), annotation]);
  });

  return [...grouped.entries()].map(([key, annotations]) => {
    const add = annotations.find((annotation) => annotation.action === "ADD");
    const remove = annotations.find(
      (annotation) => annotation.action === "REMOVE",
    );
    const confirm = annotations.find(
      (annotation) => annotation.action === "CONFIRM",
    );
    const relabel = annotations.find(
      (annotation) => annotation.action === "RELABEL",
    );
    const adjustBox = annotations.find(
      (annotation) => annotation.action === "ADJUST_BOX",
    );

    const anchor =
      add ||
      relabel ||
      adjustBox ||
      remove ||
      confirm ||
      annotations[0];

    const originalLabel =
      anchor?.original_label?.trim() ||
      annotations
        .map((annotation) => annotation.original_label?.trim())
        .find(Boolean) ||
      "No product";

    const originalBox = firstBox(annotations, "original");

    let kind: SubmissionCorrectionObject["kind"];
    if (add) kind = "ADD";
    else if (remove) kind = "REMOVE";
    else if (relabel && adjustBox) kind = "RELABEL_AND_BOX";
    else if (relabel) kind = "RELABEL";
    else if (adjustBox) kind = "ADJUST_BOX";
    else kind = "CONFIRM";

    let finalLabel: string | null;
    if (remove) {
      finalLabel = null;
    } else if (add) {
      finalLabel = add.final_label?.trim() || "Unlabeled product";
    } else if (relabel) {
      finalLabel = relabel.final_label?.trim() || originalLabel;
    } else {
      // ADJUST_BOX rows deliberately retain the original source label.
      // Only use them when no RELABEL exists for this source detection.
      finalLabel =
        adjustBox?.final_label?.trim() ||
        confirm?.final_label?.trim() ||
        anchor?.final_label?.trim() ||
        originalLabel;
    }

    let finalBox: ImageBoundingBox | null = null;
    if (!remove) {
      finalBox =
        (add ? annotationBox(add, "final") : null) ||
        (adjustBox ? annotationBox(adjustBox, "final") : null) ||
        (relabel ? annotationBox(relabel, "final") : null) ||
        (confirm ? annotationBox(confirm, "final") : null) ||
        firstBox(annotations, "final") ||
        originalBox;
    }

    const primaryAnnotationId =
      relabel?.id ||
      adjustBox?.id ||
      add?.id ||
      remove?.id ||
      confirm?.id ||
      annotations[0].id;

    const displayLabel = finalLabel || originalLabel;

    const detection: DetectionItem | null =
      finalLabel && finalBox
        ? {
            id: primaryAnnotationId,
            label: finalLabel,
            confidence: anchor?.original_confidence ?? 0,
            ...finalBox,
          }
        : null;

    return {
      key,
      primaryAnnotationId,
      annotationIds: annotations.map((annotation) => annotation.id),
      annotations,
      sourceDetectionId: anchor?.source_detection_id ?? null,
      originalLabel,
      finalLabel,
      displayLabel,
      originalBox,
      finalBox,
      detection,
      kind,
    };
  });
}

export function submissionCorrectionSummary(
  detail: AnnotationSubmissionDetail,
) {
  const objects = buildSubmissionCorrectionObjects(detail);
  const labels = [
    ...new Map(
      objects.map((object) => [
        object.displayLabel.toLocaleLowerCase(),
        object.displayLabel,
      ]),
    ).values(),
  ];

  return {
    objects,
    labels,
    objectCount: objects.length,
    changeCount: detail.annotations.length,
    firstAnnotationId: objects[0]?.primaryAnnotationId ?? null,
  };
}

import type { AnnotationItem, AnnotationSubmission } from "../../types/api";
import type { ImageBoundingBox } from "../../utils/imageCoordinates";

export const CONTRIBUTION_FILTERS = ["All", "Pending", "Approved", "Rejected", "Used"] as const;

export type ContributionFilter = typeof CONTRIBUTION_FILTERS[number];
export type ContributionSort = "Newest" | "Oldest" | "Product";
export type Contribution = { submission: AnnotationSubmission; annotation: AnnotationItem };

export type BoxEditorTarget = {
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

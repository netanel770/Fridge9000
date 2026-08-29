import type { AnnotationItem, AnnotationStatus, AnnotationSubmission, AnnotationTrainingState } from "../../types/api";
import { contributionProductLabel } from "./annotationUtils";
import type { Contribution, ContributionFilter, ContributionSort } from "./types";

export function statusTone(status: AnnotationStatus): "warning" | "success" | "danger" | "info" {
  if (status === "pending") return "warning";
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "info";
}

export function contributionChange(annotation: AnnotationItem) {
  if (annotation.action === "CONFIRM") return "Confirmed";
  if (annotation.action === "RELABEL") return `Changed to ${annotation.final_label || "a corrected product"}`;
  if (annotation.action === "REMOVE") return "Marked incorrect";
  if (annotation.action === "ADJUST_BOX") return "Adjusted product area";
  return `Added ${annotation.final_label || "unlabeled product"}`;
}

export function contributionStatus(status: AnnotationStatus, used: boolean) {
  if (used || status === "used") return "USED IN TRAINING";
  if (status === "pending") return "PENDING REVIEW";
  if (status === "approved") return "READY TO TRAIN";
  return "REJECTED";
}

export function trainingState(submission: AnnotationSubmission): AnnotationTrainingState {
  return submission.training_lifecycle_state || submission.training_state || "eligible";
}

export function trainingStateCopy(state: AnnotationTrainingState) {
  if (state === "eligible") return { label: "ELIGIBLE", tone: "success" as const, explanation: "Ready to select for the next candidate." };
  if (state === "experimental") return { label: "EXPERIMENTAL", tone: "warning" as const, explanation: "Currently being evaluated in a candidate." };
  if (state === "trusted") return { label: "TRUSTED", tone: "info" as const, explanation: "Part of the active model's trusted training baseline." };
  return { label: "QUARANTINED", tone: "danger" as const, explanation: "Excluded after its candidate was rejected." };
}

export function filterAndSortContributions(
  contributions: Contribution[],
  filter: ContributionFilter,
  search: string,
  labelFilter: string,
  sort: ContributionSort,
) {
  const query = search.trim().toLocaleLowerCase();
  const normalizedLabelFilter = labelFilter.trim().toLocaleLowerCase();
  return contributions
    .filter(({ annotation, submission }) => {
      const label = contributionProductLabel(annotation).toLocaleLowerCase();
      const latestUsage = annotation.training_usages?.[0] ?? submission.training_usages?.[0];
      const status = latestUsage ? "used" : submission.status;
      return (filter === "All" || status === filter.toLocaleLowerCase())
        && (!query || label.includes(query))
        && (!normalizedLabelFilter || label === normalizedLabelFilter);
    })
    .sort((left, right) => {
      if (sort === "Product") {
        const byProduct = contributionProductLabel(left.annotation).localeCompare(contributionProductLabel(right.annotation));
        if (byProduct) return byProduct;
      }
      const byDate = new Date(right.annotation.created_at || right.submission.created_at).getTime()
        - new Date(left.annotation.created_at || left.submission.created_at).getTime();
      return sort === "Oldest" ? -byDate : byDate;
    });
}

export function groupContributions(contributions: Contribution[], sort: ContributionSort) {
  if (sort !== "Product") return [{ label: "", contributions }];
  const groups = new Map<string, Contribution[]>();
  contributions.forEach((contribution) => {
    const label = contributionProductLabel(contribution.annotation);
    groups.set(label, [...(groups.get(label) || []), contribution]);
  });
  return [...groups].map(([label, groupedContributions]) => ({ label, contributions: groupedContributions }));
}

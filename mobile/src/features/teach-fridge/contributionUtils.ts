import type {
  AnnotationItem,
  AnnotationStatus,
  AnnotationSubmission,
  AnnotationTrainingState,
} from "../../types/api";
import { parseApiDate } from "../../utils/date";
import {
  combineAnnotationGroup,
  contributionProductLabelForContribution,
} from "./annotationUtils";
import type {
  Contribution,
  ContributionFilter,
  ContributionSort,
} from "./types";

type SubmissionWithSubmitter = AnnotationSubmission & {
  submitter_display_name?: string | null;
  submitter_email?: string | null;
};

export function statusTone(
  status: AnnotationStatus,
): "warning" | "success" | "danger" | "info" {
  if (status === "pending") return "warning";
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "info";
}

export function contributionChange(
  value: AnnotationItem | Contribution,
) {
  if ("annotations" in value) {
    const actions = new Set(value.annotations.map((item) => item.action));
    const effective = combineAnnotationGroup(value.annotations);
    const changes: string[] = [];

    if (actions.has("RELABEL")) {
      changes.push(`Changed to ${effective.final_label || "a corrected product"}`);
    }
    if (actions.has("ADJUST_BOX")) {
      changes.push("Adjusted product area");
    }
    if (actions.has("REMOVE")) {
      changes.push("Marked incorrect");
    }
    if (actions.has("CONFIRM")) {
      changes.push("Confirmed");
    }
    if (actions.has("ADD")) {
      changes.push(`Added ${effective.final_label || "unlabeled product"}`);
    }

    return changes.join(" · ") || "Submitted correction";
  }

  const annotation = value;
  if (annotation.action === "CONFIRM") return "Confirmed";
  if (annotation.action === "RELABEL") {
    return `Changed to ${annotation.final_label || "a corrected product"}`;
  }
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

export function trainingState(
  submission: AnnotationSubmission,
): AnnotationTrainingState {
  return submission.training_lifecycle_state
    || submission.training_state
    || "eligible";
}

export function trainingStateCopy(state: AnnotationTrainingState) {
  if (state === "eligible") {
    return {
      label: "ELIGIBLE",
      tone: "success" as const,
      explanation: "Ready to select for the next candidate.",
    };
  }
  if (state === "experimental") {
    return {
      label: "EXPERIMENTAL",
      tone: "warning" as const,
      explanation: "Currently being evaluated in a candidate.",
    };
  }
  if (state === "trusted") {
    return {
      label: "TRUSTED",
      tone: "info" as const,
      explanation: "Part of the active model's trusted training baseline.",
    };
  }
  return {
    label: "QUARANTINED",
    tone: "danger" as const,
    explanation: "Excluded after its candidate was rejected.",
  };
}

export function contributionLifecycleUsage(contribution: Contribution) {
  const usages = contribution.annotations
    .flatMap((annotation) => annotation.training_usages || [])
    .sort(
      (left, right) =>
        parseApiDate(right.used_at).getTime() - parseApiDate(left.used_at).getTime(),
    );
  const allUsages = usages.length ? usages : contribution.submission.training_usages || [];
  const state = trainingState(contribution.submission);
  if (state === "trusted") {
    return allUsages.find((usage) => usage.model_status === "active");
  }
  if (state === "experimental") {
    return allUsages.find((usage) => usage.model_status === "candidate");
  }
  return undefined;
}

function latestContributionUsage(contribution: Contribution) {
  const usages = contribution.annotations
    .flatMap((annotation) => annotation.training_usages || [])
    .sort(
      (left, right) =>
        parseApiDate(right.used_at).getTime() - parseApiDate(left.used_at).getTime(),
    );
  return usages[0] ?? contribution.submission.training_usages?.[0];
}

function contributionEffectiveStatus(contribution: Contribution) {
  return latestContributionUsage(contribution)
    ? "used"
    : contribution.submission.status;
}

export function contributionSubmitterLabel(contribution: Contribution) {
  const submission = contribution.submission as SubmissionWithSubmitter;
  return submission.submitter_display_name?.trim()
    || submission.submitter_email?.trim()
    || "Legacy / unknown user";
}

function contributionCreatedAt(contribution: Contribution) {
  return contribution.annotations[contribution.annotations.length - 1]?.created_at
    || contribution.submission.created_at;
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
    .filter((contribution) => {
      const label = contributionProductLabelForContribution(
        contribution,
      ).toLocaleLowerCase();
      const status = contributionEffectiveStatus(contribution);

      // "All" is the active contribution history. Training-used contributions
      // live in the explicit Used archive so the normal screen stays useful.
      if (filter === "All" && status === "used") return false;
      if (filter !== "All" && status !== filter.toLocaleLowerCase()) return false;

      return (!query || label.includes(query))
        && (!normalizedLabelFilter || label === normalizedLabelFilter);
    })
    .sort((left, right) => {
      if (sort === "Product") {
        const byProduct = contributionProductLabelForContribution(left)
          .localeCompare(contributionProductLabelForContribution(right));
        if (byProduct) return byProduct;
      }

      if (sort === "User") {
        const byUser = contributionSubmitterLabel(left)
          .localeCompare(contributionSubmitterLabel(right));
        if (byUser) return byUser;
      }

      const byDate =
        parseApiDate(contributionCreatedAt(right)).getTime()
        - parseApiDate(contributionCreatedAt(left)).getTime();

      return sort === "Oldest" ? -byDate : byDate;
    });
}

export function groupContributions(
  contributions: Contribution[],
  sort: ContributionSort,
) {
  if (sort !== "Product" && sort !== "User") {
    return [{ label: "", contributions }];
  }

  const groups = new Map<string, Contribution[]>();
  contributions.forEach((contribution) => {
    const label = sort === "User"
      ? contributionSubmitterLabel(contribution)
      : contributionProductLabelForContribution(contribution);
    groups.set(label, [...(groups.get(label) || []), contribution]);
  });

  return [...groups].map(([label, groupedContributions]) => ({
    label,
    contributions: groupedContributions,
  }));
}

import type {
  AddedClassMetrics,
  AIProgressResponse,
  AnnotationSubmissionDetail,
  CandidateState,
  ModelMetrics,
  PromotionReason,
} from "../../types/api";
import { submissionCorrectionSummary } from "./submissionCorrections";

export type ModelIdentity = { id?: number | null; version?: string | null };
export type SubmissionLabelGroup = {
  label: string;
  submissions: AnnotationSubmissionDetail[];
};

const INITIAL_MODEL_VERSION = "fridge9000-production-initial";

export const METRIC_ROWS: { key: keyof ModelMetrics; label: string }[] = [
  { key: "precision", label: "Precision" },
  { key: "recall", label: "Recall" },
  { key: "map50", label: "mAP50" },
  { key: "map50_95", label: "mAP50–95" },
];

export function candidateLifecycleControls(progress: AIProgressResponse) {
  const unresolved = progress.candidate ?? null;
  return {
    showComparisonDetails: Boolean(
      (unresolved ?? progress.latest_candidate) && progress.comparison,
    ),
    showCompare: Boolean(
      unresolved
      && progress.actions.can_compare
      && ["needs_comparison", "comparison_stale", "comparison_invalid"].includes(progress.candidate_state),
    ),
    showPromote: Boolean(
      unresolved
      && progress.candidate_state === "eligible"
      && progress.actions.can_promote,
    ),
    showReject: Boolean(unresolved && progress.actions.can_reject),
    showTrain: progress.actions.can_train,
    showRollback: progress.actions.can_rollback,
  };
}

export function candidateStateCopy(state: CandidateState) {
  if (state === "needs_comparison")
    return {
      label: "NEEDS COMPARISON",
      tone: "warning" as const,
      description:
        "Compare this candidate with the active model before deciding.",
    };
  if (state === "comparison_stale")
    return {
      label: "COMPARISON STALE",
      tone: "warning" as const,
      description:
        "The active model changed. Run the candidate comparison again.",
    };
  if (state === "comparison_invalid")
    return {
      label: "COMPARISON INVALID",
      tone: "warning" as const,
      description:
        "The saved comparison is incomplete. Retry it before deciding.",
    };
  if (state === "not_eligible")
    return {
      label: "NOT ELIGIBLE FOR PROMOTION",
      tone: "danger" as const,
      description: "This candidate did not pass the promotion policy.",
    };
  if (state === "eligible")
    return {
      label: "ELIGIBLE FOR PROMOTION",
      tone: "success" as const,
      description: "This candidate passed the promotion policy.",
    };
  return {
    label: "NO CANDIDATE",
    tone: "info" as const,
    description: "No candidate is currently under evaluation.",
  };
}

export function readableModelName(
  model: ModelIdentity | null | undefined,
  displayNames: Record<string, string>,
) {
  if (model?.version && displayNames[model.version])
    return displayNames[model.version];
  if (model?.version === INITIAL_MODEL_VERSION) return "Initial Model";
  return "Model";
}

export function formatMetric(value: number | null | undefined) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function formatMetricDifference(value: number | null | undefined) {
  if (value == null) return "—";
  const points = value * 100;
  return `${points > 0 ? "+" : ""}${points.toFixed(1)} pp`;
}

export function promotionReasonText(reason: PromotionReason) {
  if (
    reason.code === "shared_class_regression" &&
    reason.difference != null &&
    reason.maximum_regression != null
  ) {
    return `Existing-product performance changed ${formatMetricDifference(
      reason.difference,
    )}, beyond the allowed ${formatMetricDifference(
      -reason.maximum_regression,
    )}.`;
  }
  if (
    reason.code === "added_class_quality" &&
    reason.value != null &&
    reason.minimum != null
  ) {
    return `New-product average is ${formatMetric(
      reason.value,
    )}; at least ${formatMetric(reason.minimum)} is required.`;
  }
  if (
    reason.code === "added_class_below_minimum" &&
    reason.classes &&
    !Array.isArray(reason.classes) &&
    reason.minimum != null
  ) {
    return `${Object.keys(reason.classes).join(
      ", ",
    )} must reach at least ${formatMetric(reason.minimum)} mAP50–95.`;
  }
  if (
    reason.code === "removed_classes" &&
    Array.isArray(reason.classes)
  ) {
    return `Candidate removed support for ${reason.classes.join(", ")}.`;
  }
  return reason.message;
}

export function metricsForProduct(
  metrics: AddedClassMetrics | undefined,
  product: string,
) {
  const key = Object.keys(metrics?.per_class || {}).find(
    (name) => name.toLocaleLowerCase() === product.toLocaleLowerCase(),
  );
  return key ? metrics?.per_class[key] : undefined;
}

export function groupSubmissionsByLabel(
  submissions: AnnotationSubmissionDetail[],
): SubmissionLabelGroup[] {
  const groups = new Map<string, SubmissionLabelGroup>();

  submissions.forEach((detail) => {
    const { labels } = submissionCorrectionSummary(detail);

    labels.forEach((label) => {
      const key = label.toLocaleLowerCase();
      const group = groups.get(key) || { label, submissions: [] };

      if (
        !group.submissions.some(
          (current) => current.submission.id === detail.submission.id,
        )
      ) {
        group.submissions.push(detail);
      }

      groups.set(key, group);
    });
  });

  return [...groups.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

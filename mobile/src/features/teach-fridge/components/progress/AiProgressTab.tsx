import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { lifecyclePhaseLabel } from "../../../../components/LifecycleJobProvider";
import type { useLifecycleJob } from "../../../../components/LifecycleJobProvider";
import { AppButton, Card, StatusBadge } from "../../../../components/ui";
import { startCandidateComparison } from "../../../../services/api";
import { colors } from "../../../../theme";
import type { AiProgressState } from "../../hooks/useAiProgress";
import type { ModelLifecycleActions } from "../../hooks/useModelLifecycleActions";
import type { QuarantineState } from "../../hooks/useQuarantine";
import type { RollbackComparisonState } from "../../hooks/useRollbackComparison";
import type { TrainingSelectionState } from "../../hooks/useTrainingSelection";
import { candidateStateCopy, formatMetric, formatMetricDifference, promotionReasonText, readableModelName } from "../../modelUtils";
import { styles } from "../../styles";
import { SharedProductPerformance } from "./SharedProductPerformance";
import { UniqueProductPerformance } from "./UniqueProductPerformance";

export function AiProgressTab({ progress, training, quarantine, rollback, actions, lifecycle }: {
  progress: AiProgressState;
  training: TrainingSelectionState;
  quarantine: QuarantineState;
  rollback: RollbackComparisonState;
  actions: ModelLifecycleActions;
  lifecycle: ReturnType<typeof useLifecycleJob>;
}) {
  const currentCandidate = progress.stats?.candidate ?? progress.stats?.latest_candidate ?? null;
  const modelDisplayNames = progress.stats?.model_display_names || {};
  const activeModelName = readableModelName(progress.stats?.active_model, modelDisplayNames);
  const candidateModelName = readableModelName(currentCandidate, modelDisplayNames);
  const sharedMetrics = progress.stats?.comparison?.shared_class_comparison;

  return <View style={styles.suggestions}>
    <View style={styles.sectionHeading}><View><Text style={styles.sectionTitle}>AI Progress</Text><Text style={styles.sectionSubtitle}>Model status, training history, and product support.</Text></View><Pressable accessibilityRole="button" onPress={() => { void progress.load(); void training.load(); }} hitSlop={8}><Ionicons name="refresh" size={21} color={colors.primary} /></Pressable></View>
    {progress.loading ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading model progress...</Text></View> : null}
    {progress.error ? <View style={styles.errorBox}><Text style={styles.errorText}>{progress.error}</Text><AppButton label="Try Again" variant="secondary" onPress={progress.load} /></View> : null}
    {!progress.loading && progress.stats ? <>
      <Card>
        <View style={styles.modelCardHeader}><View style={styles.detectionCopy}><Text style={styles.modelRole}>ACTIVE MODEL</Text><Text style={styles.modelDisplayName}>{activeModelName}</Text></View><StatusBadge label="IN USE" tone="success" /></View>
        {lifecycle.job && (lifecycle.job.status === "queued" || lifecycle.job.status === "running") ? <View style={styles.jobStatus}><ActivityIndicator color={colors.primary} /><View style={styles.detectionCopy}><Text style={styles.jobTitle}>{lifecycle.action || (lifecycle.job.kind === "TRAIN" ? "Training new model" : "Comparing models")}</Text><Text style={styles.jobMeta}>{lifecyclePhaseLabel(lifecycle.job)}</Text></View></View> : null}
        {currentCandidate ? <>
          <View style={styles.compactDivider} />
          <View style={styles.candidateCompactRow}><View style={styles.detectionCopy}><Text style={styles.modelRole}>CANDIDATE</Text><Text style={styles.modelDisplayName}>{candidateModelName}</Text></View><StatusBadge label={candidateStateCopy(progress.stats.candidate_state).label} tone={candidateStateCopy(progress.stats.candidate_state).tone} /></View>
          <Text style={styles.actionHint}>{candidateStateCopy(progress.stats.candidate_state).description}</Text>
          {progress.stats.comparison && !progress.stats.promotion_evaluation.stale ? <View style={styles.comparisonCompact}>
            <View style={styles.comparisonCompactHeader}><View style={styles.detectionCopy}><Text style={styles.comparisonCompactTitle}>{activeModelName} vs {candidateModelName}</Text><Text style={styles.comparisonCompactText}>{progress.stats.promotion_evaluation.eligible
              ? "Candidate passed the promotion policy."
              : progress.stats.promotion_evaluation.stale
                ? "Comparison is stale. Run it again before deciding this candidate."
                : progress.stats.promotion_evaluation.reasons.some((reason) => ["comparison_missing", "missing_shared_classes", "malformed_class_metrics"].includes(reason.code))
                  ? "Comparison is incomplete or invalid. Retry it before deciding this candidate."
                  : "Candidate did not meet the promotion policy."}</Text></View><StatusBadge label={progress.stats.promotion_evaluation.eligible ? "PASS" : progress.stats.promotion_evaluation.stale || progress.stats.promotion_evaluation.reasons.some((reason) => ["comparison_missing", "missing_shared_classes", "malformed_class_metrics"].includes(reason.code)) ? "INVALID" : "FAIL"} tone={progress.stats.promotion_evaluation.eligible ? "success" : "warning"} /></View>
            <View style={styles.metricSummaryRow}><View style={styles.metricSummaryItem}><Text style={styles.metricSummaryLabel}>ACTIVE · SHARED mAP50–95</Text><Text style={styles.metricSummaryValue}>{formatMetric(sharedMetrics?.available ? sharedMetrics.active_metrics?.map50_95 : undefined)}</Text></View><View style={styles.metricSummaryItem}><Text style={styles.metricSummaryLabel}>CANDIDATE · SHARED</Text><Text style={styles.metricSummaryValue}>{formatMetric(sharedMetrics?.available ? sharedMetrics.candidate_metrics?.map50_95 : undefined)}</Text></View><View style={styles.metricSummaryItem}><Text style={styles.metricSummaryLabel}>CHANGE</Text><Text style={[styles.metricSummaryValue, ((sharedMetrics?.available ? sharedMetrics.metric_differences?.map50_95 : undefined) ?? 0) > 0 ? styles.positiveDelta : ((sharedMetrics?.available ? sharedMetrics.metric_differences?.map50_95 : undefined) ?? 0) < 0 ? styles.negativeDelta : null]}>{formatMetricDifference(sharedMetrics?.available ? sharedMetrics.metric_differences?.map50_95 : undefined)}</Text></View></View>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: progress.showModelDetails }} onPress={() => progress.setShowModelDetails((shown) => !shown)} style={styles.comparisonDetailsToggle}><Text style={styles.comparisonDetailsText}>{progress.showModelDetails ? "Hide comparison details" : "View comparison details"}</Text><Ionicons name={progress.showModelDetails ? "chevron-up" : "chevron-down"} size={16} color={colors.primary} /></Pressable>
            {progress.showModelDetails ? <View style={styles.comparisonDetails}>
              <View style={styles.comparisonRoles}><View style={styles.detectionCopy}><Text style={styles.modelRole}>CURRENT ACTIVE</Text><Text style={styles.modelVersion}>{activeModelName}</Text></View><View style={styles.detectionCopy}><Text style={styles.modelRole}>CANDIDATE</Text><Text style={styles.modelVersion}>{candidateModelName}</Text></View></View>
              <SharedProductPerformance title="Performance on Shared Products" comparison={progress.stats.comparison.shared_class_comparison} fallbackClasses={progress.stats.comparison.class_comparison.shared_classes} comparedLabel="Candidate" />
              <UniqueProductPerformance title="Performance on Added Products" products={progress.stats.comparison.class_comparison.added_classes} metrics={progress.stats.comparison.added_class_metrics} supportedBy="Candidate" unsupportedBy="Current Active" />
              {progress.stats.comparison.class_comparison.removed_classes.length ? <View style={styles.classPreservationFailure}><Ionicons name="warning" size={21} color={colors.danger} /><View style={styles.detectionCopy}><Text style={styles.classPreservationTitle}>Class preservation failure</Text><Text style={styles.classPreservationText}>Missing from candidate: {progress.stats.comparison.class_comparison.removed_classes.join(", ")}</Text></View></View> : null}
              <View style={styles.comparisonSection}><Text style={styles.comparisonSectionTitle}>Promotion Evaluation</Text><View style={styles.promotionResult}><StatusBadge label={progress.stats.promotion_evaluation.eligible ? "ELIGIBLE" : "NOT ELIGIBLE"} tone={progress.stats.promotion_evaluation.eligible ? "success" : "danger"} /><Text style={styles.comparisonSectionDescription}>Backend-authoritative promotion result</Text></View>{progress.stats.promotion_evaluation.reasons.length ? <View style={[styles.readinessBox, progress.stats.promotion_evaluation.eligible ? styles.readinessReady : styles.readinessBlocked]}><Ionicons name={progress.stats.promotion_evaluation.eligible ? "checkmark-circle" : "alert-circle"} size={20} color={progress.stats.promotion_evaluation.eligible ? colors.successFg : colors.warningFg} /><View style={styles.detectionCopy}>{progress.stats.promotion_evaluation.reasons.map((reason, index) => <Text key={`${reason.code}-${index}`} style={styles.readinessReason}>• {promotionReasonText(reason)}</Text>)}</View></View> : null}</View>
            </View> : null}
          </View> : null}
        </> : <View style={styles.lifecycleEmpty}><Ionicons name="flask-outline" size={19} color={colors.textMuted} /><Text style={styles.lifecycleEmptyText}>No candidate currently under evaluation.</Text></View>}
        {lifecycle.message || actions.message ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{actions.message || lifecycle.message}</Text></View> : null}
        {lifecycle.error || actions.error ? <View style={styles.errorBox}><Text style={styles.errorText}>{actions.error || lifecycle.error}</Text></View> : null}
      </Card>
      <View style={styles.primaryLifecycleAction}>
        {currentCandidate && ["needs_comparison", "comparison_stale", "comparison_invalid"].includes(progress.stats.candidate_state) ? <AppButton label={progress.stats.candidate_state === "needs_comparison" ? "Compare Candidate" : "Retry Comparison"} icon="analytics-outline" loading={lifecycle.action === "Compare Models"} disabled={lifecycle.busy || Boolean(actions.mutation) || !progress.stats.actions.can_compare} onPress={() => lifecycle.runJob("Compare Models", () => startCandidateComparison(currentCandidate.version))} /> : null}
        {currentCandidate && progress.stats.comparison && ["not_eligible", "eligible"].includes(progress.stats.candidate_state) ? <AppButton label="View Comparison" icon="stats-chart-outline" variant="secondary" onPress={() => progress.setShowModelDetails(true)} /> : null}
        {currentCandidate && progress.stats.candidate_state === "eligible" ? <AppButton label="Promote Candidate" icon="rocket-outline" loading={actions.mutation === "Promote Candidate"} disabled={lifecycle.busy || Boolean(actions.mutation) || !progress.stats.actions.can_promote} onPress={actions.confirmPromotion} /> : null}
        {currentCandidate ? <AppButton label="Reject Candidate" icon="close-circle-outline" variant="danger" loading={actions.mutation === "Reject Candidate"} disabled={lifecycle.busy || Boolean(actions.mutation)} onPress={actions.confirmCandidateRejection} /> : null}
        {!currentCandidate ? <AppButton label="Train a candidate" icon="school-outline" disabled={lifecycle.busy || Boolean(actions.mutation) || training.eligibleSubmissions.length === 0} onPress={() => training.setShowTrainingSelector(true)} /> : null}
        {progress.stats.actions.can_rollback ? <AppButton label="Rollback Model" icon="arrow-undo-outline" variant="secondary" onPress={rollback.open} /> : null}
        {currentCandidate ? <Text style={styles.actionHint}>Resolve the current candidate before starting another training run. Quarantine remains available below.</Text> : training.eligibleSubmissions.length === 0 ? <Text style={styles.actionHint}>Restore or approve a submission to train.</Text> : null}
      </View>
      <View style={styles.quickActions}><Pressable accessibilityRole="button" onPress={() => training.setShowTrainingHistory(true)} style={styles.quickAction}><View style={styles.quickActionIcon}><Ionicons name="time-outline" size={20} color={colors.primary} /></View><View style={styles.detectionCopy}><Text style={styles.quickActionTitle}>Training History</Text><Text style={styles.quickActionMeta}>{progress.stats.training_history.length} recent runs</Text></View><Ionicons name="chevron-forward" size={18} color={colors.textMuted} /></Pressable><Pressable accessibilityRole="button" onPress={() => quarantine.open(false)} style={[styles.quickAction, quarantine.activeSubmissions.length > 0 && styles.quickActionDanger]}><View style={[styles.quickActionIcon, quarantine.activeSubmissions.length > 0 && styles.quickActionIconDanger]}><Ionicons name="archive-outline" size={20} color={quarantine.activeSubmissions.length > 0 ? colors.danger : colors.textMuted} /></View><View style={styles.detectionCopy}><Text style={[styles.quickActionTitle, quarantine.activeSubmissions.length > 0 && styles.quickActionTitleDanger]}>Quarantine</Text><Text style={styles.quickActionMeta}>{quarantine.activeSubmissions.length} active</Text></View><Ionicons name="chevron-forward" size={18} color={quarantine.activeSubmissions.length > 0 ? colors.danger : colors.textMuted} /></Pressable></View>
      <Card><View style={styles.sectionHeading}><View><Text style={styles.sectionTitle}>Active Model Products</Text><Text style={styles.sectionSubtitle}>{progress.stats.active_model_classes.available ? `${progress.stats.active_model_classes.count} supported products` : "Product support metadata unavailable"}</Text></View><Ionicons name="pricetags-outline" size={22} color={colors.primary} /></View>{progress.stats.active_model_classes.available ? <View style={styles.classChips}>{progress.stats.active_model_classes.classes.map((name) => <View key={name} style={styles.classChip}><Text style={styles.classChipText}>{name}</Text></View>)}</View> : <Text style={styles.actionHint}>Product-class metadata is unavailable for this model.</Text>}</Card>
    </> : null}
  </View>;
}

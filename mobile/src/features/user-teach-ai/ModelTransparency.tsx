import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { AppButton, Card, EmptyState, StatusBadge } from "../../components/ui";
import { MetricComparisonTable } from "../teach-fridge/components/progress/MetricComparisonTable";
import { UniqueProductPerformance } from "../teach-fridge/components/progress/UniqueProductPerformance";
import { styles as teachStyles } from "../teach-fridge/styles";
import { colors, spacing } from "../../theme";
import type { ModelMetrics, UserModelOverview } from "../../types/api";

function negateMetrics(metrics: ModelMetrics): ModelMetrics {
  return { precision: metrics.precision == null ? null : -metrics.precision, recall: metrics.recall == null ? null : -metrics.recall, map50: metrics.map50 == null ? null : -metrics.map50, map50_95: metrics.map50_95 == null ? null : -metrics.map50_95 };
}

export function ModelTransparency({ data, loading, error, onReload }: { data: UserModelOverview | null; loading: boolean; error: string; onReload: () => void }) {
  if (loading) return <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.meta}>Loading model information...</Text></View>;
  if (error) return <View style={styles.error}><Text style={styles.errorText}>{error}</Text><AppButton label="Try again" variant="secondary" onPress={onReload} /></View>;
  if (!data?.active_model) return <Card><EmptyState icon="analytics-outline" title="No active model yet" message="Model information will appear after an active model is registered." /></Card>;
  const comparison = data.comparison;
  const currentWasCandidate = comparison?.stored_candidate_model_id === comparison?.current_model_id;
  const shared = comparison?.shared_class_comparison;
  const currentShared = currentWasCandidate ? shared?.candidate_metrics : shared?.active_metrics;
  const previousShared = currentWasCandidate ? shared?.active_metrics : shared?.candidate_metrics;
  const differences = shared?.metric_differences ? (currentWasCandidate ? shared.metric_differences : negateMetrics(shared.metric_differences)) : undefined;
  const uniqueMetricsApplyToCurrent = comparison && comparison.stored_candidate_model_id === comparison.current_model_id;
  const uniqueMetricsApplyToPrevious = comparison && comparison.stored_candidate_model_id === comparison.previous_model_id;
  return <View style={styles.content}>
    <Card><View style={styles.stack}><StatusBadge label="ACTIVE MODEL" tone="success" /><Text style={styles.model}>{data.active_model.version}</Text>{data.previous_model ? <Text style={styles.meta}>Previous active model: {data.previous_model.version}</Text> : <Text style={styles.meta}>There is no previous active model yet.</Text>}</View></Card>
    {!data.previous_model || !comparison ? <Card><EmptyState icon="git-compare-outline" title="No previous comparison" message="A read-only active-versus-previous comparison will appear after another model has been activated and comparison data is available." /></Card> : <Card><View style={teachStyles.comparisonDetails}>
      <MetricComparisonTable title="Shared Product Performance" description={`${comparison.class_comparison.shared_classes.length} product${comparison.class_comparison.shared_classes.length === 1 ? "" : "s"} supported by both models`} activeLabel="Current" comparedLabel="Previous" activeMetrics={currentShared} comparedMetrics={previousShared} differences={differences} />
      <View style={teachStyles.classChips}>{comparison.class_comparison.shared_classes.map((name) => <View key={name} style={teachStyles.classChip}><Text style={teachStyles.classChipText}>{name}</Text></View>)}</View>
      <UniqueProductPerformance title="Products Only in Current Model" products={comparison.class_comparison.only_in_current} metrics={uniqueMetricsApplyToCurrent ? comparison.added_class_metrics : undefined} supportedBy="Current" unsupportedBy="Previous" cached />
      <UniqueProductPerformance title="Products Only in Previous Model" products={comparison.class_comparison.only_in_previous} metrics={uniqueMetricsApplyToPrevious ? comparison.added_class_metrics : undefined} supportedBy="Previous" unsupportedBy="Current" cached />
    </View></Card>}
  </View>;
}

const styles = StyleSheet.create({ content: { gap: spacing.md }, stack: { gap: spacing.sm }, loading: { alignItems: "center", gap: spacing.sm, padding: spacing.xl }, meta: { color: colors.textMuted, lineHeight: 19 }, model: { color: colors.navy, fontSize: 24, fontWeight: "900" }, error: { gap: spacing.sm, padding: spacing.md, backgroundColor: colors.dangerBg }, errorText: { color: colors.danger, fontWeight: "600" } });

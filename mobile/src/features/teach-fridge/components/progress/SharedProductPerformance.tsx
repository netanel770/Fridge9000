import { Text, View } from "react-native";

import type { SharedClassComparison } from "../../../../types/api";
import { styles } from "../../styles";
import { MetricComparisonTable } from "./MetricComparisonTable";

export function SharedProductPerformance({ comparison, fallbackClasses, comparedLabel, title = "Shared Product Performance" }: { comparison: SharedClassComparison; fallbackClasses: string[]; comparedLabel: string; title?: string }) {
  const classes = comparison.classes?.length ? comparison.classes : comparison.class_names?.length ? comparison.class_names : fallbackClasses;
  return <>
    <MetricComparisonTable title={title} description={`${classes.length} product${classes.length === 1 ? "" : "s"} supported by both models`} activeLabel="Active" comparedLabel={comparedLabel} activeMetrics={comparison.available ? comparison.active_metrics : undefined} comparedMetrics={comparison.available ? comparison.candidate_metrics : undefined} differences={comparison.available ? comparison.metric_differences : undefined} />
    <View style={styles.classChips}>{classes.map((name) => <View key={name} style={styles.classChip}><Text style={styles.classChipText}>{name}</Text></View>)}</View>
    {comparison.unavailable_classes?.length ? <Text style={styles.metricsUnavailable}>Metrics unavailable for: {comparison.unavailable_classes.join(", ")}</Text> : null}
  </>;
}

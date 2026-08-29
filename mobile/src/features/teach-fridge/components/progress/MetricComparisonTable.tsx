import { Text, View } from "react-native";

import type { ModelMetrics } from "../../../../types/api";
import { formatMetric, formatMetricDifference, METRIC_ROWS } from "../../modelUtils";
import { styles } from "../../styles";

export function MetricComparisonTable({ title, description, activeLabel, comparedLabel, activeMetrics, comparedMetrics, differences }: {
  title: string;
  description?: string;
  activeLabel: string;
  comparedLabel: string;
  activeMetrics?: ModelMetrics;
  comparedMetrics?: ModelMetrics;
  differences?: ModelMetrics;
}) {
  if (!activeMetrics || !comparedMetrics) {
    return <View style={styles.comparisonSection}><Text style={styles.comparisonSectionTitle}>{title}</Text>{description ? <Text style={styles.comparisonSectionDescription}>{description}</Text> : null}<Text style={styles.metricsUnavailable}>Metrics unavailable in this comparison</Text></View>;
  }
  return <View style={styles.comparisonSection}>
    <Text style={styles.comparisonSectionTitle}>{title}</Text>
    {description ? <Text style={styles.comparisonSectionDescription}>{description}</Text> : null}
    <View style={styles.metricHeader}><Text style={styles.metricName}>METRIC</Text><Text style={styles.metricNumber}>{activeLabel.toLocaleUpperCase()}</Text><Text style={styles.metricNumber}>{comparedLabel.toLocaleUpperCase()}</Text><Text style={styles.metricDelta}>CHANGE</Text></View>
    {METRIC_ROWS.map(({ key, label }) => {
      const difference = differences?.[key];
      return <View key={key} style={styles.metricRow}><Text style={styles.metricName}>{label}</Text><Text style={styles.metricNumber}>{formatMetric(activeMetrics[key])}</Text><Text style={styles.metricNumber}>{formatMetric(comparedMetrics[key])}</Text><Text style={[styles.metricDelta, difference != null && difference > 0 ? styles.positiveDelta : difference != null && difference < 0 ? styles.negativeDelta : null]}>{formatMetricDifference(difference)}</Text></View>;
    })}
  </View>;
}

import { Text, View } from "react-native";

import type { AddedClassMetrics } from "../../../../types/api";
import { METRIC_ROWS, formatMetric, metricsForProduct } from "../../modelUtils";
import { styles } from "../../styles";

export function UniqueProductPerformance({ title, products, metrics, supportedBy, unsupportedBy, cached = false }: { title: string; products: string[]; metrics?: AddedClassMetrics; supportedBy: string; unsupportedBy: string; cached?: boolean }) {
  const hasPerClassMetrics = products.some((product) => {
    const values = metricsForProduct(metrics, product);
    return values && METRIC_ROWS.some(({ key }) => values[key] != null);
  });
  return <View style={styles.comparisonSection}>
    <Text style={styles.comparisonSectionTitle}>{title}</Text>
    {!products.length ? <Text style={styles.comparisonSectionDescription}>None</Text> : null}
    {!hasPerClassMetrics && products.length > 0 && metrics?.aggregate ? <View style={styles.productMetrics}><Text style={styles.productMetricHeading}>Aggregate across {products.length} product{products.length === 1 ? "" : "s"}</Text>{METRIC_ROWS.map(({ key, label }) => <View key={key} style={styles.productMetricRow}><Text style={styles.productMetricLabel}>{label}</Text><Text style={styles.productMetricValue}>{formatMetric(metrics.aggregate?.[key])}</Text></View>)}</View> : null}
    {products.map((product) => {
      const productMetrics = metricsForProduct(metrics, product);
      const available = productMetrics && METRIC_ROWS.some(({ key }) => productMetrics[key] != null);
      return <View key={product} style={styles.productCapability}><View style={styles.classChips}><View style={styles.classChip}><Text style={styles.classChipText}>{product}</Text></View></View><Text style={styles.productSupport}>{supportedBy}: Supported</Text>{available ? <View style={styles.productMetrics}>{METRIC_ROWS.map(({ key, label }) => <View key={key} style={styles.productMetricRow}><Text style={styles.productMetricLabel}>{label}</Text><Text style={styles.productMetricValue}>{formatMetric(productMetrics[key])}</Text></View>)}</View> : <Text style={styles.metricsUnavailable}>{cached ? "Metrics unavailable in this cached comparison" : "Metrics unavailable in this comparison"}</Text>}<Text style={styles.productUnsupported}>{unsupportedBy}: Not supported</Text></View>;
    })}
  </View>;
}

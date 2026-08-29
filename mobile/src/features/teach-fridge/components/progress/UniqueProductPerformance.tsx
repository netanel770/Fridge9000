import { Text, View } from "react-native";

import type { AddedClassMetrics, ModelMetrics } from "../../../../types/api";
import { METRIC_ROWS, formatMetric, metricsForProduct } from "../../modelUtils";
import { styles } from "../../styles";

function ProductMetricTable({ metrics, valueLabel }: { metrics: ModelMetrics; valueLabel: string }) {
  return <>
    <View style={styles.metricHeader}><Text style={styles.metricName}>METRIC</Text><Text style={styles.metricNumber}>{valueLabel.toLocaleUpperCase()}</Text></View>
    {METRIC_ROWS.map(({ key, label }) => <View key={key} style={styles.metricRow}><Text style={styles.metricName}>{label}</Text><Text style={styles.metricNumber}>{formatMetric(metrics[key])}</Text></View>)}
  </>;
}

export function UniqueProductPerformance({ title, products, metrics, supportedBy, unsupportedBy, cached = false }: { title: string; products: string[]; metrics?: AddedClassMetrics; supportedBy: string; unsupportedBy: string; cached?: boolean }) {
  const hasPerClassMetrics = products.some((product) => {
    const values = metricsForProduct(metrics, product);
    return values && METRIC_ROWS.some(({ key }) => values[key] != null);
  });
  return <View style={styles.comparisonSection}>
    <Text style={styles.comparisonSectionTitle}>{title}</Text>
    {!products.length ? <Text style={styles.comparisonSectionDescription}>None</Text> : null}
    {!hasPerClassMetrics && products.length > 0 && metrics?.aggregate ? <View style={styles.uniqueProductSection}><Text style={styles.comparisonSectionDescription}>Aggregate across {products.length} product{products.length === 1 ? "" : "s"}</Text><ProductMetricTable metrics={metrics.aggregate} valueLabel="Aggregate" /></View> : null}
    {products.map((product) => {
      const productMetrics = metricsForProduct(metrics, product);
      const available = productMetrics && METRIC_ROWS.some(({ key }) => productMetrics[key] != null);
      return <View key={product} style={styles.uniqueProductSection}><View style={styles.uniqueProductChipRow}><View style={styles.classChip}><Text style={styles.classChipText}>{product}</Text></View></View><Text style={styles.comparisonSectionDescription}>{supportedBy}: Supported</Text>{available ? <ProductMetricTable metrics={productMetrics} valueLabel={supportedBy} /> : <Text style={styles.metricsUnavailable}>{cached ? "Metrics unavailable in this cached comparison" : "Metrics unavailable in this comparison"}</Text>}<Text style={styles.comparisonSectionDescription}>{unsupportedBy}: Not supported</Text></View>;
    })}
  </View>;
}

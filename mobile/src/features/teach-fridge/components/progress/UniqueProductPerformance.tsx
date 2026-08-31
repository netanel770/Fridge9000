import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import type { AddedClassMetrics, ModelMetrics } from "../../../../types/api";
import { colors, radius, spacing } from "../../../../theme";
import {
  METRIC_ROWS,
  formatMetric,
  metricsForProduct,
} from "../../modelUtils";
import { styles } from "../../styles";

function ProductMetricGrid({ metrics }: { metrics: ModelMetrics }) {
  return (
    <View style={localStyles.metricsGrid}>
      {METRIC_ROWS.map(({ key, label }) => (
        <View key={key} style={localStyles.metricTile}>
          <Text style={localStyles.metricTileLabel}>{label}</Text>
          <Text style={localStyles.metricTileValue}>
            {formatMetric(metrics[key])}
          </Text>
        </View>
      ))}
    </View>
  );
}

function summaryMetric(metrics?: ModelMetrics) {
  return metrics?.map50_95 != null
    ? formatMetric(metrics.map50_95)
    : "Unavailable";
}

export function UniqueProductPerformance({
  title,
  products,
  metrics,
  supportedBy,
  unsupportedBy,
  cached = false,
}: {
  title: string;
  products: string[];
  metrics?: AddedClassMetrics;
  supportedBy: string;
  unsupportedBy: string;
  cached?: boolean;
}) {
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);

  const hasPerClassMetrics = products.some((product) => {
    const values = metricsForProduct(metrics, product);
    return values && METRIC_ROWS.some(({ key }) => values[key] != null);
  });

  return (
    <View style={styles.comparisonSection}>
      <Text style={styles.comparisonSectionTitle}>{title}</Text>

      {!products.length ? (
        <Text style={styles.comparisonSectionDescription}>None</Text>
      ) : null}

      {!hasPerClassMetrics && products.length > 0 && metrics?.aggregate ? (
        <View style={localStyles.aggregateCard}>
          <View style={localStyles.aggregateHeader}>
            <Text style={localStyles.aggregateTitle}>
              {products.length} added product{products.length === 1 ? "" : "s"}
            </Text>
            <View style={localStyles.summaryMetricBadge}>
              <Text style={localStyles.summaryMetricCaption}>mAP50-95</Text>
              <Text style={localStyles.summaryMetricValue}>
                {summaryMetric(metrics.aggregate)}
              </Text>
            </View>
          </View>

          <Text style={localStyles.aggregateHelper}>
            Aggregate candidate performance
          </Text>

          <ProductMetricGrid metrics={metrics.aggregate} />
        </View>
      ) : null}

      {hasPerClassMetrics ? (
        <View style={localStyles.productList}>
          {products.map((product) => {
            const productMetrics = metricsForProduct(metrics, product);
            const available =
              productMetrics &&
              METRIC_ROWS.some(({ key }) => productMetrics[key] != null);
            const expanded = expandedProduct === product;

            return (
              <View key={product} style={localStyles.productRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  accessibilityLabel={`${product}, mAP50-95 ${summaryMetric(productMetrics)}. ${expanded ? "Collapse" : "Expand"} metrics`}
                  onPress={() =>
                    setExpandedProduct((current) =>
                      current === product ? null : product,
                    )
                  }
                  style={({ pressed }) => [
                    localStyles.productToggle,
                    pressed && localStyles.productTogglePressed,
                  ]}
                >
                  <View style={localStyles.productIdentity}>
                    <View style={localStyles.newBadge}>
                      <Text style={localStyles.newBadgeText}>NEW</Text>
                    </View>
                    <Text style={localStyles.productName}>{product}</Text>
                  </View>

                  <View style={localStyles.summarySide}>
                    <View style={localStyles.summaryMetricBadge}>
                      <Text style={localStyles.summaryMetricCaption}>
                        mAP50-95
                      </Text>
                      <Text style={localStyles.summaryMetricValue}>
                        {available
                          ? summaryMetric(productMetrics)
                          : "Unavailable"}
                      </Text>
                    </View>

                    <Ionicons
                      name={expanded ? "chevron-up" : "chevron-forward"}
                      size={19}
                      color={colors.textMuted}
                    />
                  </View>
                </Pressable>

                {expanded ? (
                  <View style={localStyles.expandedContent}>
                    {available ? (
                      <ProductMetricGrid metrics={productMetrics} />
                    ) : (
                      <Text style={styles.metricsUnavailable}>
                        {cached
                          ? "Metrics unavailable in this cached comparison"
                          : "Metrics unavailable in this comparison"}
                      </Text>
                    )}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {products.length > 0 ? (
        <View style={localStyles.supportSummary}>
          <View style={localStyles.supportLine}>
            <View style={localStyles.supportDot} />
            <Text style={localStyles.supportText}>
              {supportedBy} supports all added products
            </Text>
          </View>

          <View style={localStyles.supportLine}>
            <Ionicons
              name="remove-circle-outline"
              size={16}
              color={colors.textMuted}
            />
            <Text style={localStyles.unsupportedText}>
              {unsupportedBy} does not support these products
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const localStyles = StyleSheet.create({
  productList: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  productRow: {
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  productToggle: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    padding: spacing.md,
  },
  productTogglePressed: {
    opacity: 0.78,
  },
  productIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  newBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  newBadgeText: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  productName: {
    flexShrink: 1,
    color: colors.navy,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "900",
  },
  summarySide: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  summaryMetricBadge: {
    alignItems: "flex-end",
    justifyContent: "center",
  },
  summaryMetricCaption: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  summaryMetricValue: {
    marginTop: 1,
    color: colors.navy,
    fontSize: 15,
    fontWeight: "900",
  },
  expandedContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  metricTile: {
    width: "48%",
    minHeight: 72,
    padding: spacing.sm,
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
  },
  metricTileLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "800",
  },
  metricTileValue: {
    marginTop: 2,
    color: colors.navy,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: "900",
  },
  supportSummary: {
    marginTop: spacing.md,
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceMuted,
  },
  supportLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  supportDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.successFg,
  },
  supportText: {
    flex: 1,
    color: colors.successFg,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "800",
  },
  unsupportedText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "700",
  },
  aggregateCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    gap: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  aggregateHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  aggregateTitle: {
    flex: 1,
    color: colors.navy,
    fontSize: 15,
    fontWeight: "900",
  },
  aggregateHelper: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
});

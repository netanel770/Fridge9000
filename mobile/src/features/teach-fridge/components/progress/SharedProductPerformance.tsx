import { StyleSheet, Text, View } from "react-native";

import type { SharedClassComparison } from "../../../../types/api";
import { colors, radius, spacing } from "../../../../theme";
import { styles } from "../../styles";
import { MetricComparisonTable } from "./MetricComparisonTable";

export function SharedProductPerformance({
  comparison,
  fallbackClasses,
  comparedLabel,
  title = "Shared Product Performance",
}: {
  comparison: SharedClassComparison;
  fallbackClasses: string[];
  comparedLabel: string;
  title?: string;
}) {
  const classes = comparison.classes?.length
    ? comparison.classes
    : comparison.class_names?.length
      ? comparison.class_names
      : fallbackClasses;

  return (
    <>
      <MetricComparisonTable
        title={title}
        description={`${classes.length} product${classes.length === 1 ? "" : "s"} supported by both models`}
        activeLabel="Active"
        comparedLabel={comparedLabel}
        activeMetrics={comparison.available ? comparison.active_metrics : undefined}
        comparedMetrics={comparison.available ? comparison.candidate_metrics : undefined}
        differences={comparison.available ? comparison.metric_differences : undefined}
      />

      {classes.length ? (
        <View style={localStyles.productsBlock}>
          <Text style={localStyles.productsLabel}>Shared products</Text>
          <View style={localStyles.productGrid}>
            {classes.map((name) => (
              <View key={name} style={localStyles.productChip}>
                <Text style={localStyles.productChipText}>{name}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {comparison.unavailable_classes?.length ? (
        <Text style={styles.metricsUnavailable}>
          Metrics unavailable for: {comparison.unavailable_classes.join(", ")}
        </Text>
      ) : null}
    </>
  );
}

const localStyles = StyleSheet.create({
  productsBlock: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  productsLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  productGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  productChip: {
    maxWidth: "100%",
    paddingHorizontal: spacing.sm,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  productChipText: {
    flexShrink: 1,
    color: colors.primary,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
});

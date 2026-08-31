import { StyleSheet, Text, View } from "react-native";

import type { ModelMetrics } from "../../../../types/api";
import { colors, radius, spacing } from "../../../../theme";
import {
  formatMetric,
  formatMetricDifference,
  METRIC_ROWS,
} from "../../modelUtils";
import { styles } from "../../styles";

export function MetricComparisonTable({
  title,
  description,
  activeLabel,
  comparedLabel,
  activeMetrics,
  comparedMetrics,
  differences,
}: {
  title: string;
  description?: string;
  activeLabel: string;
  comparedLabel: string;
  activeMetrics?: ModelMetrics;
  comparedMetrics?: ModelMetrics;
  differences?: ModelMetrics;
}) {
  if (!activeMetrics || !comparedMetrics) {
    return (
      <View style={styles.comparisonSection}>
        <Text style={styles.comparisonSectionTitle}>{title}</Text>
        {description ? (
          <Text style={styles.comparisonSectionDescription}>{description}</Text>
        ) : null}
        <Text style={styles.metricsUnavailable}>
          Metrics unavailable in this comparison
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.comparisonSection}>
      <Text style={styles.comparisonSectionTitle}>{title}</Text>
      {description ? (
        <Text style={styles.comparisonSectionDescription}>{description}</Text>
      ) : null}

      <View style={localStyles.legend}>
        <Text style={localStyles.legendText}>{activeLabel}</Text>
        <Text style={localStyles.arrow}>→</Text>
        <Text style={[localStyles.legendText, localStyles.candidateLegend]}>
          {comparedLabel}
        </Text>
      </View>

      <View style={localStyles.metricList}>
        {METRIC_ROWS.map(({ key, label }) => {
          const difference = differences?.[key];
          const positive = difference != null && difference > 0;
          const negative = difference != null && difference < 0;

          return (
            <View key={key} style={localStyles.metricCard}>
              <View style={localStyles.metricTopRow}>
                <Text style={localStyles.metricLabel}>{label}</Text>
                <View
                  style={[
                    localStyles.deltaBadge,
                    positive
                      ? localStyles.deltaPositive
                      : negative
                        ? localStyles.deltaNegative
                        : localStyles.deltaNeutral,
                  ]}
                >
                  <Text
                    style={[
                      localStyles.deltaText,
                      positive
                        ? localStyles.deltaPositiveText
                        : negative
                          ? localStyles.deltaNegativeText
                          : localStyles.deltaNeutralText,
                    ]}
                  >
                    {formatMetricDifference(difference)}
                  </Text>
                </View>
              </View>

              <View style={localStyles.valueRow}>
                <View style={localStyles.valueBlock}>
                  <Text style={localStyles.valueCaption}>{activeLabel}</Text>
                  <Text style={localStyles.activeValue}>
                    {formatMetric(activeMetrics[key])}
                  </Text>
                </View>

                <Text style={localStyles.valueArrow}>→</Text>

                <View style={[localStyles.valueBlock, localStyles.valueBlockRight]}>
                  <Text style={localStyles.valueCaption}>{comparedLabel}</Text>
                  <Text style={localStyles.candidateValue}>
                    {formatMetric(comparedMetrics[key])}
                  </Text>
                </View>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const localStyles = StyleSheet.create({
  legend: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  legendText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  candidateLegend: {
    color: colors.primary,
  },
  arrow: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "900",
  },
  metricList: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  metricCard: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  metricTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  metricLabel: {
    flex: 1,
    color: colors.navy,
    fontSize: 14,
    fontWeight: "900",
  },
  deltaBadge: {
    minWidth: 68,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  deltaPositive: {
    backgroundColor: colors.successBg,
  },
  deltaNegative: {
    backgroundColor: colors.dangerBg,
  },
  deltaNeutral: {
    backgroundColor: colors.surfaceMuted,
  },
  deltaText: {
    fontSize: 12,
    fontWeight: "900",
  },
  deltaPositiveText: {
    color: colors.successFg,
  },
  deltaNegativeText: {
    color: colors.danger,
  },
  deltaNeutralText: {
    color: colors.textMuted,
  },
  valueRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
  },
  valueBlock: {
    flex: 1,
    minWidth: 0,
  },
  valueBlockRight: {
    alignItems: "flex-end",
  },
  valueCaption: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  activeValue: {
    color: colors.textSecondary,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: "900",
  },
  candidateValue: {
    color: colors.navy,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: "900",
    textAlign: "right",
  },
  valueArrow: {
    color: colors.textMuted,
    fontSize: 18,
    fontWeight: "900",
    paddingBottom: 1,
  },
});

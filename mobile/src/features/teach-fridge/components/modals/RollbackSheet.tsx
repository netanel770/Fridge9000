import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import type { useLifecycleJob } from "../../../../components/LifecycleJobProvider";
import { AppButton, EmptyState } from "../../../../components/ui";
import { colors } from "../../../../theme";
import type { AiProgressState } from "../../hooks/useAiProgress";
import type { ModelLifecycleActions } from "../../hooks/useModelLifecycleActions";
import type { RollbackComparisonState } from "../../hooks/useRollbackComparison";
import { readableModelName } from "../../modelUtils";
import { styles } from "../../styles";
import { MetricComparisonTable } from "../progress/MetricComparisonTable";
import { SharedProductPerformance } from "../progress/SharedProductPerformance";
import { UniqueProductPerformance } from "../progress/UniqueProductPerformance";

export function RollbackSheet({ progress, rollback, actions, lifecycle }: {
  progress: AiProgressState;
  rollback: RollbackComparisonState;
  actions: ModelLifecycleActions;
  lifecycle: ReturnType<typeof useLifecycleJob>;
}) {
  const displayNames = progress.stats?.model_display_names || {};
  const activeModelName = readableModelName(progress.stats?.active_model, displayNames);
  const rollbackTargetName = (version: string) => readableModelName(progress.stats?.rollback_targets.find((model) => model.version === version), displayNames);

  return <Modal visible={rollback.show} transparent animationType="slide" statusBarTranslucent onRequestClose={rollback.close}>
    <View style={styles.sheetBackdrop}><View style={styles.sheet}>
      {rollback.target ? <>
        <View style={styles.imageHeader}><View><Text style={styles.imageTitle}>Compare Models</Text><Text style={styles.imageSubtitle}>Cached comparison against the current active model</Text></View><Pressable accessibilityLabel="Back to rollback models" onPress={rollback.back} hitSlop={10}><Ionicons name="arrow-back" size={25} color={colors.navy} /></Pressable></View>
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
          {rollback.error ? <View style={styles.errorBox}><Text style={styles.errorText}>{rollback.error}</Text></View> : null}
          {rollback.comparison?.available && rollback.comparison.comparison ? <>
            <View style={styles.rollbackComparisonModels}><View style={styles.detectionCopy}><Text style={styles.modelRole}>CURRENT ACTIVE</Text><Text style={styles.modelVersion}>{readableModelName(rollback.comparison.comparison.active_model, displayNames)}</Text></View><View style={styles.detectionCopy}><Text style={styles.modelRole}>PREVIOUS PRODUCTION</Text><Text style={styles.modelVersion}>{readableModelName(rollback.comparison.comparison.rollback_target, displayNames)}</Text></View></View>
            <Text style={styles.trainingMeta}>Historical comparison from {new Date(rollback.comparison.comparison.created_at).toLocaleString("en-GB")} · Dataset {rollback.comparison.comparison.dataset_version}</Text>
            <MetricComparisonTable title="Overall Performance" activeLabel="Active" comparedLabel="Previous" activeMetrics={rollback.comparison.comparison.active_metrics} comparedMetrics={rollback.comparison.comparison.rollback_target_metrics} differences={rollback.comparison.comparison.metric_differences} />
            <SharedProductPerformance comparison={rollback.comparison.comparison.shared_class_comparison} fallbackClasses={rollback.comparison.comparison.class_comparison.shared_classes} comparedLabel="Previous" />
            <UniqueProductPerformance title="Products only in Current Active" products={rollback.comparison.comparison.class_comparison.only_in_active} supportedBy="Current Active" unsupportedBy="Previous Production" cached />
            <UniqueProductPerformance title="Products only in Previous Model" products={rollback.comparison.comparison.class_comparison.only_in_rollback_target} metrics={rollback.comparison.comparison.added_class_metrics} supportedBy="Previous Production" unsupportedBy="Current Active" cached />
            <Text style={styles.rollbackInformational}>This cached historical comparison is informational and does not affect rollback availability.</Text>
            <AppButton label={`Roll Back to ${rollbackTargetName(rollback.target.version)}`} icon="arrow-undo-outline" variant="danger" disabled={lifecycle.busy || Boolean(actions.mutation)} loading={actions.mutation === "Rollback Model"} onPress={() => actions.confirmRollback(rollback.target!.version)} />
          </> : !rollback.error ? <EmptyState icon="information-circle-outline" title="No cached comparison" message={`No cached comparison is available between ${rollbackTargetName(rollback.target.version)} and ${activeModelName}. You can still select this model for rollback.`} /> : null}
        </ScrollView>
        <AppButton label="Back" variant="secondary" onPress={rollback.back} />
      </> : <>
        <View style={styles.imageHeader}><View><Text style={styles.imageTitle}>Select Model to Roll Back To</Text><Text style={styles.imageSubtitle}>Previous production models</Text></View><Pressable accessibilityLabel="Close rollback models" onPress={rollback.close} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable></View>
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
          {progress.stats?.rollback_targets.length ? progress.stats.rollback_targets.map((model) => {
            const selected = rollback.selectedVersion === model.version;
            const modelName = readableModelName(model, displayNames);
            return <View key={model.id} style={[styles.rollbackChoice, selected && styles.rollbackChoiceSelected]}><Pressable accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`Select ${modelName} for rollback`} onPress={() => rollback.setSelectedVersion(model.version)} style={styles.rollbackChoiceMain}><Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={24} color={selected ? colors.primary : colors.textMuted} /><View style={styles.detectionCopy}><Text style={styles.modelVersion}>{modelName}</Text><Text style={styles.trainingMeta}>Previously active · {new Date(model.archived_at || model.last_activated_at || model.created_at).toLocaleDateString("en-GB")}</Text><Text style={styles.trainingMeta}>{model.classes_available ? `${model.supported_product_count} supported products` : "Product support metadata unavailable"}</Text></View></Pressable><AppButton label="Compare against active" icon="stats-chart-outline" variant="secondary" loading={rollback.loadingVersion === model.version} disabled={rollback.loadingVersion !== null} onPress={() => rollback.viewComparison(model)} /></View>;
          }) : <EmptyState icon="arrow-undo-outline" title="No previous production models" message="A previous active model will appear here when rollback is available." />}
          {rollback.error ? <View style={styles.errorBox}><Text style={styles.errorText}>{rollback.error}</Text></View> : null}
        </ScrollView>
        <View style={styles.rollbackFooter}><View style={styles.detectionAction}><AppButton label="Cancel" variant="secondary" onPress={rollback.close} /></View><View style={styles.detectionAction}><AppButton label={rollback.selectedVersion ? `Rollback to ${rollbackTargetName(rollback.selectedVersion)}` : "Select a model"} icon="arrow-undo-outline" variant="danger" disabled={!rollback.selectedVersion || lifecycle.busy || Boolean(actions.mutation)} loading={actions.mutation === "Rollback Model"} onPress={() => rollback.selectedVersion && actions.confirmRollback(rollback.selectedVersion)} /></View></View>
      </>}
    </View></View>
  </Modal>;
}

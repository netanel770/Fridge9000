import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { EmptyState, StatusBadge } from "../../../../components/ui";
import { colors } from "../../../../theme";
import type { AiProgressState } from "../../hooks/useAiProgress";
import type { TrainingSelectionState } from "../../hooks/useTrainingSelection";
import { readableModelName } from "../../modelUtils";
import { styles } from "../../styles";

export function TrainingHistorySheet({ progress, training }: { progress: AiProgressState; training: TrainingSelectionState }) {
  const displayNames = progress.stats?.model_display_names || {};
  return <Modal visible={training.showTrainingHistory} transparent animationType="slide" statusBarTranslucent onRequestClose={() => training.setShowTrainingHistory(false)}>
    <View style={styles.sheetBackdrop}><View style={styles.sheet}><View style={styles.imageHeader}><View><Text style={styles.imageTitle}>Training History</Text><Text style={styles.imageSubtitle}>Actual candidate training runs</Text></View><Pressable accessibilityLabel="Close training history" onPress={() => training.setShowTrainingHistory(false)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable></View><ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
      {progress.stats?.training_history.length ? <View style={styles.trainingHistory}>{progress.stats.training_history.map((run) => <View key={run.training_run_id} style={styles.trainingRow}><View style={styles.trainingMarker}><Ionicons name={run.status === "completed" ? "checkmark" : run.status === "running" ? "hourglass-outline" : "close"} size={18} color={run.status === "completed" ? colors.successFg : run.status === "running" ? colors.warningFg : colors.danger} /></View><View style={styles.detectionCopy}><Text style={styles.trainingModel}>{run.model_version ? readableModelName({ id: run.model_id, version: run.model_version }, displayNames) : "No model produced"}</Text><Text style={styles.trainingMeta}>{new Date(run.ended_at || run.started_at).toLocaleString("en-GB")}</Text><Text style={styles.trainingMeta}>{run.submission_count} submissions · {run.annotation_count} annotations</Text></View><StatusBadge label={run.status.toUpperCase()} tone={run.status === "completed" ? "success" : run.status === "running" ? "warning" : "danger"} /></View>)}</View> : <EmptyState icon="time-outline" title="No training history" message="Training runs will appear here." />}
    </ScrollView></View></View>
  </Modal>;
}

import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import type { useLifecycleJob } from "../../../../components/LifecycleJobProvider";
import { AppButton, EmptyState } from "../../../../components/ui";
import { startCandidateTraining } from "../../../../services/api";
import { colors } from "../../../../theme";
import { AnnotationSubmissionPreview } from "../contributions/AnnotationSubmissionPreview";
import type { QuarantineState } from "../../hooks/useQuarantine";
import type { TrainingSelectionState } from "../../hooks/useTrainingSelection";
import { styles } from "../../styles";

export function TrainingDataSheet({ training, quarantine, lifecycle, onBeforeStart }: {
  training: TrainingSelectionState;
  quarantine: QuarantineState;
  lifecycle: ReturnType<typeof useLifecycleJob>;
  onBeforeStart: () => void;
}) {
  function startTraining() {
    const selectedIds = [...training.selectedTrainingSubmissions].sort((left, right) => left - right);
    if (!selectedIds.length) return;
    onBeforeStart();
    training.setShowTrainingSelector(false);
    void lifecycle.runJob("Train Candidate", () => startCandidateTraining(selectedIds));
  }

  return <Modal visible={training.showTrainingSelector} transparent animationType="slide" statusBarTranslucent onRequestClose={() => training.setShowTrainingSelector(false)}>
    <View style={styles.sheetBackdrop}>
      <View style={styles.sheet}>
        <View style={styles.imageHeader}><View><Text style={styles.imageTitle}>Select training data</Text><Text style={styles.imageSubtitle}>{training.selectedTrainingSubmissions.size} submissions · {training.selectedAnnotationCount} annotations selected</Text></View><Pressable accessibilityLabel="Close training selection" onPress={() => training.setShowTrainingSelector(false)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable></View>
        <View style={styles.selectionControls}><Text style={styles.selectionAvailable}>{training.eligibleSubmissions.length} eligible submissions</Text><View style={styles.selectionControlButtons}><Pressable accessibilityRole="button" onPress={() => training.setSelectedTrainingSubmissions(new Set(training.eligibleSubmissions.map((detail) => detail.submission.id)))} style={styles.selectionControl}><Text style={styles.selectionControlText}>Select all</Text></Pressable><Pressable accessibilityRole="button" disabled={training.selectedTrainingSubmissions.size === 0} onPress={() => training.setSelectedTrainingSubmissions(new Set())} style={styles.selectionControl}><Text style={[styles.selectionControlText, training.selectedTrainingSubmissions.size === 0 && styles.selectionControlDisabled]}>Clear</Text></Pressable></View></View>
        <Text style={styles.sheetHelper}>Select whole submissions. Trusted data is included automatically.</Text>
        {training.quarantinedSubmissions.length ? <Pressable accessibilityRole="button" onPress={() => quarantine.open(true)} style={styles.sheetQuarantineLink}><Ionicons name="archive-outline" size={18} color={colors.danger} /><Text style={styles.sheetQuarantineText}>Manage Quarantine ({quarantine.activeSubmissions.length} active)</Text><Ionicons name="chevron-forward" size={17} color={colors.danger} /></Pressable> : null}
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
          {training.loading ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading annotations...</Text></View> : null}
          {training.message ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{training.message}</Text></View> : null}
          {training.error ? <View style={styles.errorBox}><Text style={styles.errorText}>{training.error}</Text><AppButton label="Try Again" variant="secondary" onPress={() => training.load()} /></View> : null}
          {!training.loading && !training.error && training.trainingLabelGroups.length === 0 ? <EmptyState icon="checkmark-done-outline" title="Nothing ready to train" message="Approve a contribution first." /> : null}
          {training.trainingLabelGroups.map((group) => {
            const ids = group.submissions.map((detail) => detail.submission.id);
            const selectedCount = ids.filter((id) => training.selectedTrainingSubmissions.has(id)).length;
            const expanded = training.expandedTrainingLabel === group.label;
            return <View key={group.label} style={styles.trainingGroup}>
              <View style={styles.trainingGroupRow}><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedCount === ids.length }} accessibilityLabel={`Select all ${group.label} submissions`} onPress={() => training.toggleTrainingGroup(group.submissions)} hitSlop={8}><Ionicons name={selectedCount === ids.length ? "checkbox" : selectedCount ? "remove-circle" : "square-outline"} size={25} color={selectedCount ? colors.primary : colors.textMuted} /></Pressable><Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => training.setExpandedTrainingLabel(expanded ? null : group.label)} style={styles.trainingGroupOpen}><View style={styles.detectionCopy}><Text style={styles.trainingGroupTitle}>{group.label}</Text><Text style={styles.trainingGroupMeta}>{group.submissions.length} submission{group.submissions.length === 1 ? "" : "s"} · {selectedCount} selected</Text></View><Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color={colors.textMuted} /></Pressable></View>
              {expanded ? <View style={styles.trainingDrilldown}>{group.submissions.map((detail) => {
                const selected = training.selectedTrainingSubmissions.has(detail.submission.id);
                const detailExpanded = training.expandedTrainingSubmission === detail.submission.id;
                return <View key={detail.submission.id} style={[styles.trainingSubmissionDetail, selected && styles.trainingSelectionRowSelected]}>
                  <View style={styles.trainingSubmissionRow}>
                    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`Select submission ${detail.submission.id}`} onPress={() => training.toggleTrainingGroup([detail])} hitSlop={8}><Ionicons name={selected ? "checkbox" : "square-outline"} size={23} color={selected ? colors.primary : colors.textMuted} /></Pressable>
                    <Pressable accessibilityRole="button" accessibilityState={{ expanded: detailExpanded }} accessibilityLabel={`${detailExpanded ? "Collapse" : "Expand"} submission ${detail.submission.id}`} onPress={() => { training.setExpandedTrainingSubmission(detailExpanded ? null : detail.submission.id); training.setFocusedTrainingAnnotation(detailExpanded ? null : detail.annotations[0]?.id ?? null); }} style={styles.trainingSubmissionOpen}><View style={styles.detectionCopy}><Text style={styles.trainingSelectionTitle}>Submission #{detail.submission.id} · {detail.annotations.length} annotation{detail.annotations.length === 1 ? "" : "s"}</Text></View><Ionicons name={detailExpanded ? "chevron-up" : "chevron-down"} size={18} color={colors.textMuted} /></Pressable>
                  </View>
                  {detailExpanded ? <View style={styles.quarantineDetails}><AnnotationSubmissionPreview detail={detail} focusedAnnotationId={training.focusedTrainingAnnotation} onFocusAnnotation={training.setFocusedTrainingAnnotation} /><AppButton label="Move to Quarantine" icon="archive-outline" variant="secondary" loading={quarantine.mutation === detail.submission.id} disabled={quarantine.mutation !== null} onPress={() => quarantine.moveFromTraining(detail.submission.id)} /></View> : null}
                </View>;
              })}</View> : null}
            </View>;
          })}
        </ScrollView>
        <AppButton label={`Train with ${training.selectedTrainingSubmissions.size} submission${training.selectedTrainingSubmissions.size === 1 ? "" : "s"}`} icon="school-outline" loading={lifecycle.action === "Train Candidate"} disabled={lifecycle.busy || training.selectedTrainingSubmissions.size === 0} onPress={startTraining} />
      </View>
    </View>
  </Modal>;
}

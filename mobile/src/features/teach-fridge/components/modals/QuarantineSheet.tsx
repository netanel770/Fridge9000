import { Modal, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppButton, EmptyState, StatusBadge } from "../../../../components/ui";
import { colors } from "../../../../theme";
import { contributionProductLabel } from "../../annotationUtils";
import type { AiProgressState } from "../../hooks/useAiProgress";
import type { QuarantineState } from "../../hooks/useQuarantine";
import type { TrainingSelectionState } from "../../hooks/useTrainingSelection";
import { styles } from "../../styles";
import { AnnotationSubmissionPreview } from "../contributions/AnnotationSubmissionPreview";

export function QuarantineSheet({ progress, training, quarantine }: { progress: AiProgressState; training: TrainingSelectionState; quarantine: QuarantineState }) {
  return <Modal visible={quarantine.show} transparent animationType="slide" statusBarTranslucent onRequestClose={() => quarantine.setShow(false)}>
    <View style={styles.sheetBackdrop}><View style={styles.sheet}>
      <View style={styles.imageHeader}><View><Text style={styles.imageTitle}>Quarantine</Text><Text style={styles.imageSubtitle}>{quarantine.activeSubmissions.length} active · {quarantine.archivedCount} archived · {training.selectedQuarantineSubmissions.size} selected</Text></View><Pressable accessibilityLabel="Close quarantine" onPress={() => quarantine.setShow(false)} hitSlop={10}><Ionicons name="close" size={27} color={colors.navy} /></Pressable></View>
      <View style={styles.archiveToggleRow}><View style={styles.detectionCopy}><Text style={styles.selectionAvailable}>Show archived</Text><Text style={styles.archiveToggleHint}>Archived items remain quarantined and excluded from training.</Text></View><Switch accessibilityLabel="Show archived quarantined submissions" value={quarantine.showArchived} disabled={training.loading} onValueChange={quarantine.toggleArchived} trackColor={{ false: colors.border, true: colors.primarySoft }} thumbColor={quarantine.showArchived ? colors.primary : colors.textMuted} /></View>
      {quarantine.activeSubmissions.length ? <View style={styles.selectionControls}><Text style={styles.selectionAvailable}>Select submissions to return to training</Text><View style={styles.selectionControlButtons}><Pressable accessibilityRole="button" onPress={() => training.setSelectedQuarantineSubmissions(new Set(quarantine.activeSubmissions.map((detail) => detail.submission.id)))} style={styles.selectionControl}><Text style={styles.selectionControlText}>Select all</Text></Pressable><Pressable accessibilityRole="button" disabled={training.selectedQuarantineSubmissions.size === 0} onPress={() => training.setSelectedQuarantineSubmissions(new Set())} style={styles.selectionControl}><Text style={[styles.selectionControlText, training.selectedQuarantineSubmissions.size === 0 && styles.selectionControlDisabled]}>Clear</Text></Pressable></View></View> : null}
      <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
        {quarantine.message ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{quarantine.message}</Text></View> : null}
        {quarantine.error ? <View style={styles.errorBox}><Text style={styles.errorText}>{quarantine.error}</Text></View> : null}
        {training.error ? <View style={styles.errorBox}><Text style={styles.errorText}>{training.error}</Text><AppButton label="Try Again" variant="secondary" onPress={() => training.load(quarantine.showArchived)} /></View> : null}
        {quarantine.labelGroups.length ? quarantine.labelGroups.map((group) => {
          const expanded = quarantine.expandedLabel === group.label;
          const groupIds = [...new Set(group.submissions.map((detail) => detail.submission.id))];
          const selectableGroupIds = [...new Set(group.submissions.filter((detail) => !detail.submission.archived_at).map((detail) => detail.submission.id))];
          const selectedCount = selectableGroupIds.filter((id) => training.selectedQuarantineSubmissions.has(id)).length;
          const allSelected = selectableGroupIds.length > 0 && selectedCount === selectableGroupIds.length;
          return <View key={group.label} style={styles.trainingGroup}>
            <View style={styles.trainingGroupRow}>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: allSelected, disabled: selectableGroupIds.length === 0 }} accessibilityLabel={`Select all active quarantined ${group.label} submissions`} disabled={selectableGroupIds.length === 0} onPress={() => quarantine.toggleGroup(group.submissions)} hitSlop={8}><Ionicons name={allSelected ? "checkbox" : selectedCount ? "remove-circle" : selectableGroupIds.length ? "square-outline" : "lock-closed-outline"} size={25} color={selectedCount ? colors.primary : colors.textMuted} /></Pressable>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => quarantine.setExpandedLabel(expanded ? null : group.label)} style={styles.trainingGroupOpen}><View style={styles.quarantineGroupIcon}><Ionicons name="archive-outline" size={19} color={colors.danger} /></View><View style={styles.detectionCopy}><Text style={styles.trainingGroupTitle}>{group.label}</Text><Text style={styles.trainingGroupMeta}>{groupIds.length} submission{groupIds.length === 1 ? "" : "s"} · {selectedCount} selected</Text></View><Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color={colors.textMuted} /></Pressable>
            </View>
            {expanded ? <View style={styles.trainingDrilldown}>{group.submissions.map((detail) => {
              const submissionExpanded = quarantine.expandedSubmission === detail.submission.id;
              const selected = training.selectedQuarantineSubmissions.has(detail.submission.id);
              const archived = Boolean(detail.submission.archived_at);
              const labels = [...new Set(detail.annotations.map(contributionProductLabel))];
              return <View key={detail.submission.id} style={[styles.quarantineSubmission, selected && styles.trainingSelectionRowSelected, archived && styles.quarantineSubmissionArchived]}>
                <View style={styles.quarantineSubmissionRow}>
                  <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled: archived }} accessibilityLabel={archived ? `Archived submission ${detail.submission.id} cannot be selected` : `Select submission ${detail.submission.id}`} disabled={archived} onPress={() => quarantine.toggleGroup([detail])} hitSlop={8}><Ionicons name={archived ? "lock-closed-outline" : selected ? "checkbox" : "square-outline"} size={23} color={selected ? colors.primary : colors.textMuted} /></Pressable>
                  <Pressable accessibilityRole="button" accessibilityState={{ expanded: submissionExpanded }} onPress={() => { quarantine.setExpandedSubmission(submissionExpanded ? null : detail.submission.id); quarantine.setFocusedAnnotation(submissionExpanded ? null : detail.annotations[0]?.id ?? null); }} style={styles.trainingGroupOpen}><View style={styles.detectionCopy}><View style={styles.quarantineSubmissionTitleRow}><Text style={styles.trainingSelectionTitle}>Submission #{detail.submission.id}</Text>{archived ? <StatusBadge label="ARCHIVED" tone="info" /> : null}</View><Text style={styles.detectionMeta}>{labels.join(" · ")} · {detail.annotations.length} annotation{detail.annotations.length === 1 ? "" : "s"}</Text></View><Ionicons name={submissionExpanded ? "chevron-up" : "chevron-down"} size={18} color={colors.textMuted} /></Pressable>
                </View>
                {submissionExpanded ? <View style={styles.quarantineDetails}><AnnotationSubmissionPreview detail={detail} focusedAnnotationId={quarantine.focusedAnnotation} onFocusAnnotation={quarantine.setFocusedAnnotation} /><AppButton label={archived ? "Unarchive" : "Archive"} icon={archived ? "arrow-up-circle-outline" : "archive-outline"} variant="secondary" loading={quarantine.mutation === detail.submission.id} disabled={quarantine.mutation !== null} onPress={() => quarantine.applyAction(detail.submission.id, archived ? "unarchive" : "archive")} /></View> : null}
              </View>;
            })}</View> : null}
          </View>;
        }) : <EmptyState icon="shield-checkmark-outline" title={quarantine.archivedCount && !quarantine.showArchived ? "No active quarantine items" : "Nothing quarantined"} message={quarantine.archivedCount && !quarantine.showArchived ? "Turn on Show archived to inspect archived submissions." : "Rejected candidate data will appear here."} />}
      </ScrollView>
      {quarantine.activeSubmissions.length ? <AppButton label={`Return ${training.selectedQuarantineSubmissions.size} to training`} icon="refresh-outline" loading={quarantine.mutation === -1} disabled={quarantine.mutation !== null || training.selectedQuarantineSubmissions.size === 0} onPress={quarantine.restoreSelected} /> : null}
      <AppButton label="Continue to Train Model" icon="school-outline" variant="secondary" disabled={Boolean(progress.stats?.latest_candidate)} onPress={quarantine.returnToTrainingSelection} />
      {progress.stats?.latest_candidate ? <Text style={styles.actionHint}>Training will unlock after the current candidate is resolved. Your quarantine selections can be returned to training now.</Text> : null}
    </View></View>
  </Modal>;
}

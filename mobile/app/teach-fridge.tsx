import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";

import { useLifecycleJob } from "../src/components/LifecycleJobProvider";
import { uniqueProductLabels } from "../src/components/ProductLabelInput";
import { ScreenHeader } from "../src/components/ui";
import { ContributionsTab } from "../src/features/teach-fridge/components/contributions/ContributionsTab";
import { AnnotationModals } from "../src/features/teach-fridge/components/modals/AnnotationModals";
import { QuarantineSheet } from "../src/features/teach-fridge/components/modals/QuarantineSheet";
import { RollbackSheet } from "../src/features/teach-fridge/components/modals/RollbackSheet";
import { TrainingDataSheet } from "../src/features/teach-fridge/components/modals/TrainingDataSheet";
import { TrainingHistorySheet } from "../src/features/teach-fridge/components/modals/TrainingHistorySheet";
import { AiProgressTab } from "../src/features/teach-fridge/components/progress/AiProgressTab";
import { SuggestionsTab } from "../src/features/teach-fridge/components/suggestions/SuggestionsTab";
import { useAiProgress } from "../src/features/teach-fridge/hooks/useAiProgress";
import { useAnnotationEditors } from "../src/features/teach-fridge/hooks/useAnnotationEditors";
import { useContributions } from "../src/features/teach-fridge/hooks/useContributions";
import { useModelLifecycleActions } from "../src/features/teach-fridge/hooks/useModelLifecycleActions";
import { useModeration } from "../src/features/teach-fridge/hooks/useModeration";
import { useQuarantine } from "../src/features/teach-fridge/hooks/useQuarantine";
import { useRollbackComparison } from "../src/features/teach-fridge/hooks/useRollbackComparison";
import { useSuggestions } from "../src/features/teach-fridge/hooks/useSuggestions";
import { useTrainingSelection } from "../src/features/teach-fridge/hooks/useTrainingSelection";
import { readableModelName } from "../src/features/teach-fridge/modelUtils";
import { styles } from "../src/features/teach-fridge/styles";
import { colors } from "../src/theme";
import type { RecentScan } from "../src/types/api";
import { useAuth } from "../src/features/auth/AuthContext";
import { useHousehold } from "../src/features/households/HouseholdContext";

type TeachTab = "Suggestions" | "Contributions" | "AI Progress";
const TABS: TeachTab[] = ["Suggestions", "Contributions", "AI Progress"];

export default function TeachFridgeScreen() {
  const { user } = useAuth();
  const params = useLocalSearchParams<Record<string, string>>();
  if (!user?.is_system_admin) return <Redirect href={{ pathname: "/teach-user" as never, params }} />;
  return <AdminTeachFridgeScreen />;
}

function AdminTeachFridgeScreen() {
  const { selected } = useHousehold();
  const { scanId: requestedScanIdParam, detectionId: requestedDetectionIdParam, addMissed, tab } = useLocalSearchParams<{ scanId?: string; detectionId?: string; addMissed?: string; tab?: string }>();
  const requestedScanId = Number(requestedScanIdParam);
  const requestedDetectionId = Number(requestedDetectionIdParam);
  const hasValidRequestedScan = Number.isInteger(requestedScanId) && requestedScanId > 0;
  const hasTargetedDetection = hasValidRequestedScan && Number.isInteger(requestedDetectionId) && requestedDetectionId > 0;
  const [activeTab, setActiveTab] = useState<TeachTab>(tab === "AI Progress" || !selected ? "AI Progress" : "Suggestions");
  const lifecycle = useLifecycleJob();

  const addMissedHandler = useRef<((scan: RecentScan) => Promise<void>) | null>(null);
  const selectionStartHandler = useRef<(() => void) | null>(null);
  const suggestions = useSuggestions({ active: Boolean(selected), requestedScanId, requestedDetectionId, hasValidRequestedScan, hasTargetedDetection, addMissed, addMissedHandler, selectionStartHandler });
  const contributionsState = useContributions(Boolean(selected) && activeTab === "Contributions");
  const moderation = useModeration(activeTab === "Contributions");
  const { scans, selectedScan, detections, loadingScans, loadingDetections, error: suggestionsError, setError: setSuggestionsError, selectScan, loadSuggestions } = suggestions;
  const { contributions, loadContributions } = contributionsState;
  const editors = useAnnotationEditors({ selectedScan, refreshScan: selectScan, loadContributions, setSuggestionsError });
  const {
    imageDetection, setImageDetection, editDetection, setEditDetection, finalLabel, setFinalLabel, inventoryLabels,
    savingLabel, labelError, setLabelError, submissionMessage, pendingRelabels,
    removeDetection, setRemoveDetection, removingDetectionId, removeError, setRemoveError, pendingRemovals,
    contributionImage, setContributionImage, editContribution, setEditContribution, contributionLabel, setContributionLabel,
    contributionEditError, setContributionEditError, savingContribution, contributionMessage,
    boxEditor, setBoxEditor, savingBox, boxError, setBoxError, pendingBoxes,
    confirmDetection, setConfirmDetection, confirmingDetectionId, confirmError, setConfirmError, pendingConfirms,
    openLabelEditor, saveRelabel, confirmRemoveDetection, submitDetectionConfirmation, openContributionEditor,
    saveContributionLabel, openSuggestionBoxEditor, openAddBoxEditor, openAddBoxEditorForScan,
    openContributionBoxEditor, saveBoxCorrection,
  } = editors;
  addMissedHandler.current = openAddBoxEditorForScan;
  selectionStartHandler.current = () => setImageDetection(null);

  const progress = useAiProgress(activeTab === "AI Progress", lifecycle.completionCount);
  const training = useTrainingSelection(activeTab === "AI Progress", lifecycle.completionCount);
  const loadProgress = progress.load;
  const loadTrainingSelection = training.load;
  const refreshLifecycleData = useCallback(async () => {
    await Promise.all([loadProgress(), loadTrainingSelection(), loadContributions()]);
  }, [loadContributions, loadProgress, loadTrainingSelection]);
  const quarantine = useQuarantine(training, refreshLifecycleData);
  const rollback = useRollbackComparison();
  const modelDisplayNames = progress.stats?.model_display_names || {};
  const currentCandidate = progress.stats?.candidate ?? progress.stats?.latest_candidate ?? null;
  const activeModelName = readableModelName(progress.stats?.active_model, modelDisplayNames);
  const candidateModelName = readableModelName(currentCandidate, modelDisplayNames);
  const rollbackTargetName = useCallback((version: string) => readableModelName(
    progress.stats?.rollback_targets.find((model) => model.version === version),
    progress.stats?.model_display_names || {},
  ), [progress.stats]);
  const actions = useModelLifecycleActions({ progress: progress.stats, activeModelName, candidateModelName, rollbackTargetName, refreshLifecycleData, onRollbackComplete: rollback.complete });

  useEffect(() => {
    if (tab === "AI Progress") setActiveTab("AI Progress");
  }, [tab]);

  const productLabelSuggestions = useMemo(() => uniqueProductLabels([
    ...inventoryLabels.map((item) => item.name),
    ...contributions.flatMap(({ annotation }) => [annotation.final_label, annotation.original_label]),
    ...(progress.stats?.comparison?.class_comparison.active_classes || []),
    ...(progress.stats?.comparison?.class_comparison.candidate_classes || []),
  ]), [contributions, inventoryLabels, progress.stats]);
  const displayNameForModel = useCallback((model: { id?: number | null; version?: string | null } | null | undefined) => readableModelName(model, progress.stats?.model_display_names || {}), [progress.stats]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <ScreenHeader eyebrow="Help the fridge learn" title="Teach AI" subtitle="Correct a prediction, add a missed product, or follow improvements." />
      <View accessibilityRole="tablist" style={styles.tabs}>
        {(selected ? TABS : ["AI Progress"] as TeachTab[]).map((teachTab) => {
          const selected = activeTab === teachTab;
          return <Pressable key={teachTab} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => setActiveTab(teachTab)} style={[styles.tab, selected && styles.activeTab]}><Text style={[styles.tabText, selected && styles.activeTabText]}>{teachTab}</Text></Pressable>;
        })}
      </View>

      {activeTab === "Suggestions" ? (
        <SuggestionsTab
          scans={scans}
          selectedScan={selectedScan}
          detections={detections}
          loadingScans={loadingScans}
          loadingDetections={loadingDetections}
          error={suggestionsError}
          submissionMessage={submissionMessage}
          hasTargetedDetection={hasTargetedDetection}
          requestedScanId={requestedScanId}
          requestedDetectionId={requestedDetectionId}
          pendingRelabels={pendingRelabels}
          pendingRemovals={pendingRemovals}
          pendingBoxes={pendingBoxes}
          pendingConfirms={pendingConfirms}
          onReload={loadSuggestions}
          onSelectScan={(scan) => { void selectScan(scan); }}
          onAddMissed={() => { void openAddBoxEditor(); }}
          onViewContributions={() => setActiveTab("Contributions")}
          onCorrectLabel={(detection) => { void openLabelEditor(detection); }}
          onRemove={(detection) => { setRemoveError(""); setRemoveDetection(detection); }}
          onViewImage={setImageDetection}
          onAdjustBox={openSuggestionBoxEditor}
          onConfirm={(detection) => { setConfirmError(""); setConfirmDetection(detection); }}
        />
      ) : activeTab === "Contributions" ? (
        <ContributionsTab contributions={contributionsState} productLabelSuggestions={productLabelSuggestions} contributionMessage={contributionMessage} displayNameForModel={displayNameForModel} onViewImage={setContributionImage} onEditLabel={(contribution) => { void openContributionEditor(contribution); }} onEditBox={openContributionBoxEditor} moderation={moderation} allowEditing={false} />
      ) : (
        <AiProgressTab progress={progress} training={training} quarantine={quarantine} rollback={rollback} actions={actions} lifecycle={lifecycle} />
      )}

      {activeTab !== "AI Progress" ? <View style={styles.note}><Ionicons name="information-circle-outline" size={19} color={colors.infoFg} /><Text style={styles.noteText}>Contributions are stored separately for review. Original YOLO detections remain unchanged.</Text></View> : null}

      <TrainingDataSheet training={training} quarantine={quarantine} lifecycle={lifecycle} onBeforeStart={actions.clearMessage} />
      <TrainingHistorySheet progress={progress} training={training} />
      <RollbackSheet progress={progress} rollback={rollback} actions={actions} lifecycle={lifecycle} />
      <QuarantineSheet progress={progress} training={training} quarantine={quarantine} />

      <AnnotationModals
        imageDetection={imageDetection}
        selectedScan={selectedScan}
        detections={detections}
        onCloseImage={() => setImageDetection(null)}
        editDetection={editDetection}
        finalLabel={finalLabel}
        savingLabel={savingLabel}
        labelError={labelError}
        productLabelSuggestions={productLabelSuggestions}
        onChangeFinalLabel={(value) => { setFinalLabel(value); setLabelError(""); }}
        onCloseLabel={() => setEditDetection(null)}
        onSaveLabel={() => { void saveRelabel(); }}
        removeDetection={removeDetection}
        removingDetectionId={removingDetectionId}
        removeError={removeError}
        onCloseRemove={() => setRemoveDetection(null)}
        onConfirmRemove={() => { void confirmRemoveDetection(); }}
        confirmDetection={confirmDetection}
        confirmingDetectionId={confirmingDetectionId}
        confirmError={confirmError}
        onCloseConfirm={() => setConfirmDetection(null)}
        onConfirmDetection={() => { void submitDetectionConfirmation(); }}
        contributionImage={contributionImage}
        useAdminContributionImages
        onCloseContributionImage={() => setContributionImage(null)}
        editContribution={editContribution}
        contributionLabel={contributionLabel}
        contributionEditError={contributionEditError}
        savingContribution={savingContribution}
        onChangeContributionLabel={(value) => { setContributionLabel(value); setContributionEditError(""); }}
        onCloseContributionEditor={() => setEditContribution(null)}
        onSaveContributionLabel={() => { void saveContributionLabel(); }}
        boxEditor={boxEditor}
        savingBox={savingBox}
        boxError={boxError}
        onCloseBoxEditor={() => setBoxEditor(null)}
        onBoxChange={(box) => setBoxEditor((current) => current ? { ...current, box } : null)}
        onBoxLabelChange={(label) => { setBoxError(""); setBoxEditor((current) => current ? { ...current, label } : null); }}
        onResetBox={() => setBoxEditor((current) => current ? { ...current, box: current.originalBox } : null)}
        onSaveBox={() => { void saveBoxCorrection(); }}
      />
    </ScrollView>
  );
}

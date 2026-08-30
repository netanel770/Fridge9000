import { useMemo, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";

import { uniqueProductLabels } from "../src/components/ProductLabelInput";
import { ScreenHeader } from "../src/components/ui";
import { ContributionsTab } from "../src/features/teach-fridge/components/contributions/ContributionsTab";
import { AnnotationModals } from "../src/features/teach-fridge/components/modals/AnnotationModals";
import { SuggestionsTab } from "../src/features/teach-fridge/components/suggestions/SuggestionsTab";
import { useAnnotationEditors } from "../src/features/teach-fridge/hooks/useAnnotationEditors";
import { useContributions } from "../src/features/teach-fridge/hooks/useContributions";
import { useSuggestions } from "../src/features/teach-fridge/hooks/useSuggestions";
import { styles } from "../src/features/teach-fridge/styles";
import { ModelTransparency } from "../src/features/user-teach-ai/ModelTransparency";
import { useUserModelOverview } from "../src/features/user-teach-ai/useUserModelOverview";
import { colors } from "../src/theme";
import type { RecentScan } from "../src/types/api";
import { useAuth } from "../src/features/auth/AuthContext";

type UserTeachTab = "My Scans" | "My Contributions" | "Model";
const TABS: UserTeachTab[] = ["My Scans", "My Contributions", "Model"];

export default function UserTeachAiScreen() {
  const { user } = useAuth();
  if (user?.is_system_admin) return <Redirect href="/teach-fridge" />;
  return <UserTeachAiContent />;
}

function UserTeachAiContent() {
  const params = useLocalSearchParams<{ scanId?: string; detectionId?: string; addMissed?: string }>();
  const requestedScanId = Number(params.scanId); const requestedDetectionId = Number(params.detectionId);
  const hasValidRequestedScan = Number.isInteger(requestedScanId) && requestedScanId > 0;
  const hasTargetedDetection = hasValidRequestedScan && Number.isInteger(requestedDetectionId) && requestedDetectionId > 0;
  const [activeTab, setActiveTab] = useState<UserTeachTab>("My Scans");
  const addMissedHandler = useRef<((scan: RecentScan) => Promise<void>) | null>(null);
  const selectionStartHandler = useRef<(() => void) | null>(null);
  const suggestions = useSuggestions({ requestedScanId, requestedDetectionId, hasValidRequestedScan, hasTargetedDetection, addMissed: params.addMissed, addMissedHandler, selectionStartHandler });
  const contributionsState = useContributions(activeTab === "My Contributions", "mine");
  const editors = useAnnotationEditors({ selectedScan: suggestions.selectedScan, refreshScan: suggestions.selectScan, loadContributions: contributionsState.loadContributions, setSuggestionsError: suggestions.setError });
  addMissedHandler.current = editors.openAddBoxEditorForScan;
  selectionStartHandler.current = () => editors.setImageDetection(null);
  const model = useUserModelOverview(activeTab === "Model");
  const productLabelSuggestions = useMemo(() => uniqueProductLabels([
    ...editors.inventoryLabels.map((item) => item.name),
    ...contributionsState.contributions.flatMap(({ annotation }) => [annotation.final_label, annotation.original_label]),
  ]), [contributionsState.contributions, editors.inventoryLabels]);

  return <ScrollView style={styles.screen} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
    <ScreenHeader eyebrow="Help the fridge learn" title="Teach AI" subtitle="Correct your scans, follow your contributions, and see how the active model changed." />
    <View accessibilityRole="tablist" style={styles.tabs}>{TABS.map((tab) => { const selected = tab === activeTab; return <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => setActiveTab(tab)} style={[styles.tab, selected && styles.activeTab]}><Text style={[styles.tabText, selected && styles.activeTabText]}>{tab}</Text></Pressable>; })}</View>
    {activeTab === "My Scans" ? <SuggestionsTab scans={suggestions.scans} selectedScan={suggestions.selectedScan} detections={suggestions.detections} loadingScans={suggestions.loadingScans} loadingDetections={suggestions.loadingDetections} error={suggestions.error} submissionMessage={editors.submissionMessage} hasTargetedDetection={hasTargetedDetection} requestedScanId={requestedScanId} requestedDetectionId={requestedDetectionId} pendingRelabels={editors.pendingRelabels} pendingRemovals={editors.pendingRemovals} pendingBoxes={editors.pendingBoxes} pendingConfirms={editors.pendingConfirms} onReload={suggestions.loadSuggestions} onSelectScan={(scan) => { void suggestions.selectScan(scan); }} onAddMissed={() => { void editors.openAddBoxEditor(); }} onViewContributions={() => setActiveTab("My Contributions")} onCorrectLabel={(detection) => { void editors.openLabelEditor(detection); }} onRemove={(detection) => { editors.setRemoveError(""); editors.setRemoveDetection(detection); }} onViewImage={editors.setImageDetection} onAdjustBox={editors.openSuggestionBoxEditor} onConfirm={(detection) => { editors.setConfirmError(""); editors.setConfirmDetection(detection); }} />
      : activeTab === "My Contributions" ? <ContributionsTab contributions={contributionsState} productLabelSuggestions={productLabelSuggestions} contributionMessage={editors.contributionMessage} displayNameForModel={(identity) => identity.version || "Model"} onViewImage={editors.setContributionImage} onEditLabel={(contribution) => { void editors.openContributionEditor(contribution); }} onEditBox={editors.openContributionBoxEditor} />
      : <ModelTransparency data={model.data} loading={model.loading} error={model.error} onReload={() => { void model.load(); }} />}
    {activeTab !== "Model" ? <View style={styles.note}><Ionicons name="information-circle-outline" size={19} color={colors.infoFg} /><Text style={styles.noteText}>You only see scans and contributions owned by your account in the selected household.</Text></View> : null}
    <AnnotationModals imageDetection={editors.imageDetection} selectedScan={suggestions.selectedScan} detections={suggestions.detections} onCloseImage={() => editors.setImageDetection(null)} editDetection={editors.editDetection} finalLabel={editors.finalLabel} savingLabel={editors.savingLabel} labelError={editors.labelError} productLabelSuggestions={productLabelSuggestions} onChangeFinalLabel={(value) => { editors.setFinalLabel(value); editors.setLabelError(""); }} onCloseLabel={() => editors.setEditDetection(null)} onSaveLabel={() => { void editors.saveRelabel(); }} removeDetection={editors.removeDetection} removingDetectionId={editors.removingDetectionId} removeError={editors.removeError} onCloseRemove={() => editors.setRemoveDetection(null)} onConfirmRemove={() => { void editors.confirmRemoveDetection(); }} confirmDetection={editors.confirmDetection} confirmingDetectionId={editors.confirmingDetectionId} confirmError={editors.confirmError} onCloseConfirm={() => editors.setConfirmDetection(null)} onConfirmDetection={() => { void editors.submitDetectionConfirmation(); }} contributionImage={editors.contributionImage} onCloseContributionImage={() => editors.setContributionImage(null)} editContribution={editors.editContribution} contributionLabel={editors.contributionLabel} contributionEditError={editors.contributionEditError} savingContribution={editors.savingContribution} onChangeContributionLabel={(value) => { editors.setContributionLabel(value); editors.setContributionEditError(""); }} onCloseContributionEditor={() => editors.setEditContribution(null)} onSaveContributionLabel={() => { void editors.saveContributionLabel(); }} boxEditor={editors.boxEditor} savingBox={editors.savingBox} boxError={editors.boxError} onCloseBoxEditor={() => editors.setBoxEditor(null)} onBoxChange={(box) => editors.setBoxEditor((current) => current ? { ...current, box } : null)} onBoxLabelChange={(label) => { editors.setBoxError(""); editors.setBoxEditor((current) => current ? { ...current, label } : null); }} onResetBox={() => editors.setBoxEditor((current) => current ? { ...current, box: current.originalBox } : null)} onSaveBox={() => { void editors.saveBoxCorrection(); }} />
  </ScrollView>;
}

import { useCallback, useState } from "react";
import { Alert } from "react-native";

import { promoteCandidate, rejectCandidate, rollbackModel } from "../../../services/api";
import type { AIProgressResponse } from "../../../types/api";

export function useModelLifecycleActions({
  progress,
  activeModelName,
  candidateModelName,
  rollbackTargetName,
  refreshLifecycleData,
  onRollbackComplete,
}: {
  progress: AIProgressResponse | null;
  activeModelName: string;
  candidateModelName: string;
  rollbackTargetName: (version: string) => string;
  refreshLifecycleData: () => Promise<void>;
  onRollbackComplete: () => void;
}) {
  const [mutation, setMutation] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const confirmPromotion = useCallback(() => {
    if (!progress?.latest_candidate || !progress.comparison) return;
    Alert.alert(`Promote ${candidateModelName}?`, `Make ${candidateModelName} the active production model? ${activeModelName} will remain available for rollback.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Promote", onPress: async () => {
        setMutation("Promote Candidate"); setError(""); setMessage("");
        try {
          await promoteCandidate(progress.latest_candidate!.version, progress.comparison!.id);
          setMessage("Candidate promoted. The previous active model is available for rollback.");
          await refreshLifecycleData();
        } catch (caught) { setError(caught instanceof Error ? caught.message : "Promotion failed."); }
        finally { setMutation(null); }
      } },
    ]);
  }, [activeModelName, candidateModelName, progress, refreshLifecycleData]);

  const confirmCandidateRejection = useCallback(() => {
    if (!progress?.latest_candidate) return;
    const version = progress.latest_candidate.version;
    Alert.alert(
      `Reject ${candidateModelName}?`,
      "This model will not become active. Its experimental annotations will move to Quarantine for review.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Reject", style: "destructive", onPress: async () => {
          setMutation("Reject Candidate"); setError(""); setMessage("");
          try {
            const result = await rejectCandidate(version);
            setMessage(`Candidate rejected. ${result.quarantined_submission_count} experimental submission${result.quarantined_submission_count === 1 ? " was" : "s were"} quarantined.`);
            await refreshLifecycleData();
          } catch (caught) { setError(caught instanceof Error ? caught.message : "Candidate rejection failed."); }
          finally { setMutation(null); }
        } },
      ],
    );
  }, [candidateModelName, progress, refreshLifecycleData]);

  const confirmRollback = useCallback((version: string) => {
    const targetName = rollbackTargetName(version);
    Alert.alert(`Roll back to ${targetName}?`, `Current active model: ${activeModelName}\n\nNew active model: ${targetName}\n\nThis will replace the model currently used for product detection.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Confirm Rollback", style: "destructive", onPress: async () => {
        setMutation("Rollback Model"); setError(""); setMessage("");
        try {
          await rollbackModel(version);
          setMessage(`Rolled back to ${targetName}.`);
          onRollbackComplete();
          await refreshLifecycleData();
        } catch (caught) { setError(caught instanceof Error ? caught.message : "Rollback failed."); }
        finally { setMutation(null); }
      } },
    ]);
  }, [activeModelName, onRollbackComplete, refreshLifecycleData, rollbackTargetName]);

  return { mutation, message, error, clearMessage: () => setMessage(""), confirmPromotion, confirmCandidateRejection, confirmRollback };
}

export type ModelLifecycleActions = ReturnType<typeof useModelLifecycleActions>;

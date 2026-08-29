import { useCallback, useMemo, useState } from "react";

import { manageQuarantinedSubmission } from "../../../services/api";
import { groupSubmissionsByLabel } from "../modelUtils";
import type { TrainingSelectionState } from "./useTrainingSelection";

export function useQuarantine(training: TrainingSelectionState, refreshLifecycleData: () => Promise<void>) {
  const [show, setShow] = useState(false);
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);
  const [expandedSubmission, setExpandedSubmission] = useState<number | null>(null);
  const [focusedAnnotation, setFocusedAnnotation] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [mutation, setMutation] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const activeSubmissions = useMemo(
    () => training.quarantinedSubmissions.filter((detail) => !detail.submission.archived_at),
    [training.quarantinedSubmissions],
  );
  const archivedCount = training.quarantinedSubmissions.length - activeSubmissions.length;
  const displayedSubmissions = showArchived ? training.quarantinedSubmissions : activeSubmissions;
  const labelGroups = useMemo(() => groupSubmissionsByLabel(displayedSubmissions), [displayedSubmissions]);

  const open = useCallback((fromTraining = false) => {
    setShowArchived(false);
    void training.load(false);
    if (fromTraining) training.setShowTrainingSelector(false);
    setTimeout(() => setShow(true), fromTraining ? 200 : 0);
  }, [training]);

  const returnToTrainingSelection = useCallback(() => {
    setShow(false);
    setTimeout(() => training.setShowTrainingSelector(true), 200);
  }, [training]);

  const toggleArchived = useCallback((includeArchived: boolean) => {
    setShowArchived(includeArchived);
    void training.load(includeArchived);
  }, [training]);

  const toggleGroup = useCallback((submissions: typeof training.quarantinedSubmissions) => {
    const ids = [...new Set(submissions.filter((detail) => !detail.submission.archived_at).map((detail) => detail.submission.id))];
    training.setSelectedQuarantineSubmissions((current) => {
      const allSelected = ids.length > 0 && ids.every((id) => current.has(id));
      const next = new Set(current);
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }, [training]);

  const moveFromTraining = useCallback(async (submissionId: number) => {
    setMutation(submissionId);
    training.setError("");
    training.setMessage("");
    try {
      await manageQuarantinedSubmission(submissionId, "quarantine");
      training.setSelectedTrainingSubmissions((current) => {
        const next = new Set(current);
        next.delete(submissionId);
        return next;
      });
      training.setExpandedTrainingSubmission(null);
      training.setFocusedTrainingAnnotation(null);
      training.setMessage("Submission moved to Quarantine.");
      await refreshLifecycleData();
    } catch (caught) {
      training.setError(caught instanceof Error ? caught.message : "Could not move the submission to Quarantine.");
    } finally {
      setMutation(null);
    }
  }, [refreshLifecycleData, training]);

  const applyAction = useCallback(async (submissionId: number, action: "restore" | "archive" | "unarchive") => {
    setMutation(submissionId);
    setError("");
    setMessage("");
    try {
      await manageQuarantinedSubmission(submissionId, action);
      setExpandedSubmission(null);
      setFocusedAnnotation(null);
      setMessage(
        action === "restore"
          ? "Returned to eligible training data."
          : action === "archive"
            ? "Submission archived from the active Quarantine workload."
            : "Submission returned to the active Quarantine workload.",
      );
      await refreshLifecycleData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the submission.");
    } finally {
      setMutation(null);
    }
  }, [refreshLifecycleData]);

  const restoreSelected = useCallback(async () => {
    const selectedIds = [...training.selectedQuarantineSubmissions].sort((left, right) => left - right);
    if (!selectedIds.length || mutation !== null) return;
    setMutation(-1);
    setError("");
    setMessage("");
    try {
      for (const submissionId of selectedIds) {
        await manageQuarantinedSubmission(submissionId, "restore");
      }
      training.setSelectedQuarantineSubmissions(new Set());
      setMessage(`${selectedIds.length} submission${selectedIds.length === 1 ? "" : "s"} returned and ready to select for training.`);
      await refreshLifecycleData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not return the selected submissions to training.");
    } finally {
      setMutation(null);
    }
  }, [mutation, refreshLifecycleData, training]);

  return {
    show,
    setShow,
    expandedLabel,
    setExpandedLabel,
    expandedSubmission,
    setExpandedSubmission,
    focusedAnnotation,
    setFocusedAnnotation,
    showArchived,
    mutation,
    error,
    message,
    activeSubmissions,
    archivedCount,
    labelGroups,
    open,
    returnToTrainingSelection,
    toggleArchived,
    toggleGroup,
    moveFromTraining,
    applyAction,
    restoreSelected,
  };
}

export type QuarantineState = ReturnType<typeof useQuarantine>;

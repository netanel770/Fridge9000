import { useCallback, useState } from "react";

import {
  promoteCandidate,
  rejectCandidate,
  rollbackModel,
} from "../../../services/api";
import type { AIProgressResponse } from "../../../types/api";
import { confirmAction } from "../../../utils/confirm";

type ConfirmationOptions = {
  title: string;
  message: string;
  confirmText: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
};

async function requestConfirmation({
  title,
  message,
  confirmText,
  destructive = false,
  onConfirm,
}: ConfirmationOptions) {
  if (await confirmAction({ title, message, confirmText, destructive })) await onConfirm();
}

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
    if (!progress?.latest_candidate || !progress.comparison) {
      return;
    }

    const candidateVersion = progress.latest_candidate.version;
    const comparisonId = progress.comparison.id;

    requestConfirmation({
      title: `Promote ${candidateModelName}?`,
      message:
        `Make ${candidateModelName} the active production model? ` +
        `${activeModelName} will remain available for rollback.`,
      confirmText: "Promote",
      onConfirm: async () => {
        setMutation("Promote Candidate");
        setError("");
        setMessage("");

        try {
          await promoteCandidate(
            candidateVersion,
            comparisonId,
          );

          setMessage(
            "Candidate promoted. The previous active model is available for rollback.",
          );

          await refreshLifecycleData();
        } catch (caught) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Promotion failed.",
          );
        } finally {
          setMutation(null);
        }
      },
    });
  }, [
    activeModelName,
    candidateModelName,
    progress,
    refreshLifecycleData,
  ]);

  const confirmCandidateRejection = useCallback(() => {
    if (!progress?.latest_candidate) {
      return;
    }

    const version = progress.latest_candidate.version;

    requestConfirmation({
      title: `Reject ${candidateModelName}?`,
      message:
        "This model will not become active. Its experimental annotations " +
        "will move to Quarantine for review.",
      confirmText: "Reject",
      destructive: true,
      onConfirm: async () => {
        setMutation("Reject Candidate");
        setError("");
        setMessage("");

        try {
          const result = await rejectCandidate(version);

          setMessage(
            `Candidate rejected. ` +
              `${result.quarantined_submission_count} experimental ` +
              `submission${
                result.quarantined_submission_count === 1
                  ? " was"
                  : "s were"
              } quarantined.`,
          );

          await refreshLifecycleData();
        } catch (caught) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Candidate rejection failed.",
          );
        } finally {
          setMutation(null);
        }
      },
    });
  }, [
    candidateModelName,
    progress,
    refreshLifecycleData,
  ]);

  const confirmRollback = useCallback(
    (version: string) => {
      if (!progress?.actions.can_rollback) {
        setError("Resolve the current candidate before rolling back.");
        return;
      }
      const targetName = rollbackTargetName(version);

      requestConfirmation({
        title: `Roll back to ${targetName}?`,
        message:
          `Current active model: ${activeModelName}\n\n` +
          `New active model: ${targetName}\n\n` +
          "This will replace the model currently used for product detection.",
        confirmText: "Confirm Rollback",
        destructive: true,
        onConfirm: async () => {
          setMutation("Rollback Model");
          setError("");
          setMessage("");

          try {
            await rollbackModel(version);

            setMessage(`Rolled back to ${targetName}.`);

            onRollbackComplete();

            await refreshLifecycleData();
          } catch (caught) {
            setError(
              caught instanceof Error
                ? caught.message
                : "Rollback failed.",
            );
          } finally {
            setMutation(null);
          }
        },
      });
    },
    [
      activeModelName,
      onRollbackComplete,
      progress,
      refreshLifecycleData,
      rollbackTargetName,
    ],
  );

  return {
    mutation,
    message,
    error,
    clearMessage: () => setMessage(""),
    confirmPromotion,
    confirmCandidateRejection,
    confirmRollback,
  };
}

export type ModelLifecycleActions =
  ReturnType<typeof useModelLifecycleActions>;

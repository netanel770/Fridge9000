import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getAnnotationSubmission, getAnnotationSubmissions } from "../../../services/api";
import type { AnnotationSubmissionDetail } from "../../../types/api";
import { trainingState } from "../contributionUtils";
import { groupSubmissionsByLabel } from "../modelUtils";

export function useTrainingSelection(active: boolean, lifecycleCompletionCount: number) {
  const [eligibleSubmissions, setEligibleSubmissions] = useState<AnnotationSubmissionDetail[]>([]);
  const [quarantinedSubmissions, setQuarantinedSubmissions] = useState<AnnotationSubmissionDetail[]>([]);
  const [selectedTrainingSubmissions, setSelectedTrainingSubmissions] = useState<Set<number>>(new Set());
  const [selectedQuarantineSubmissions, setSelectedQuarantineSubmissions] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showTrainingSelector, setShowTrainingSelector] = useState(false);
  const [expandedTrainingLabel, setExpandedTrainingLabel] = useState<string | null>(null);
  const [expandedTrainingSubmission, setExpandedTrainingSubmission] = useState<number | null>(null);
  const [focusedTrainingAnnotation, setFocusedTrainingAnnotation] = useState<number | null>(null);
  const [showTrainingHistory, setShowTrainingHistory] = useState(false);
  const request = useRef(0);
  const includeArchivedRef = useRef(false);

  const load = useCallback(async (includeArchived = includeArchivedRef.current) => {
    includeArchivedRef.current = includeArchived;
    const requestId = ++request.current;
    setLoading(true);
    setError("");
    try {
      const submissions = await getAnnotationSubmissions(undefined, includeArchived);
      const lifecycleSubmissions = submissions.filter((submission) =>
        ["approved", "used"].includes(submission.status) && ["eligible", "quarantined"].includes(trainingState(submission))
      );
      const details = await Promise.all(lifecycleSubmissions.map((submission) => getAnnotationSubmission(submission.id)));
      const eligible = details.filter((detail) => trainingState(detail.submission) === "eligible");
      const quarantined = details.filter((detail) => trainingState(detail.submission) === "quarantined");
      if (request.current !== requestId) return;
      setEligibleSubmissions(eligible);
      setQuarantinedSubmissions(quarantined);
      const eligibleIds = new Set(eligible.map((detail) => detail.submission.id));
      const quarantinedIds = new Set(quarantined.filter((detail) => !detail.submission.archived_at).map((detail) => detail.submission.id));
      setSelectedTrainingSubmissions((current) => new Set([...current].filter((id) => eligibleIds.has(id))));
      setSelectedQuarantineSubmissions((current) => new Set([...current].filter((id) => quarantinedIds.has(id))));
    } catch (caught) {
      if (request.current === requestId) {
        setEligibleSubmissions([]);
        setQuarantinedSubmissions([]);
        setSelectedTrainingSubmissions(new Set());
        setSelectedQuarantineSubmissions(new Set());
        setError(caught instanceof Error ? caught.message : "Could not load eligible annotations.");
      }
    } finally {
      if (request.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, lifecycleCompletionCount, load]);

  const selectedAnnotationCount = useMemo(
    () => eligibleSubmissions.reduce(
      (count, detail) => count + (selectedTrainingSubmissions.has(detail.submission.id) ? detail.annotations.length : 0),
      0,
    ),
    [eligibleSubmissions, selectedTrainingSubmissions],
  );
  const trainingLabelGroups = useMemo(() => groupSubmissionsByLabel(eligibleSubmissions), [eligibleSubmissions]);

  const toggleTrainingGroup = useCallback((submissions: AnnotationSubmissionDetail[]) => {
    const ids = submissions.map((detail) => detail.submission.id);
    setSelectedTrainingSubmissions((current) => {
      const allSelected = ids.every((id) => current.has(id));
      const next = new Set(current);
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }, []);

  return {
    eligibleSubmissions,
    quarantinedSubmissions,
    selectedTrainingSubmissions,
    setSelectedTrainingSubmissions,
    selectedQuarantineSubmissions,
    setSelectedQuarantineSubmissions,
    loading,
    error,
    setError,
    message,
    setMessage,
    load,
    showTrainingSelector,
    setShowTrainingSelector,
    expandedTrainingLabel,
    setExpandedTrainingLabel,
    expandedTrainingSubmission,
    setExpandedTrainingSubmission,
    focusedTrainingAnnotation,
    setFocusedTrainingAnnotation,
    showTrainingHistory,
    setShowTrainingHistory,
    selectedAnnotationCount,
    trainingLabelGroups,
    toggleTrainingGroup,
  };
}

export type TrainingSelectionState = ReturnType<typeof useTrainingSelection>;

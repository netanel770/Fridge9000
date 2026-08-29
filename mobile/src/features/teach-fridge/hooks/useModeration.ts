import { useCallback, useEffect, useRef, useState } from "react";

import { getAnnotationSubmission, getAnnotationSubmissions, moderateAnnotationSubmission } from "../../../services/api";
import type { AnnotationSubmissionDetail } from "../../../types/api";

export function useModeration(active: boolean) {
  const [submissions, setSubmissions] = useState<AnnotationSubmissionDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [moderatingSubmissionId, setModeratingSubmissionId] = useState<number | null>(null);
  const [expandedAnnotationIds, setExpandedAnnotationIds] = useState<Set<number>>(new Set());
  const request = useRef(0);

  const loadModeration = useCallback(async () => {
    const requestId = ++request.current;
    setLoading(true);
    setError("");
    try {
      const pending = await getAnnotationSubmissions("pending");
      const details = await Promise.all(pending.map((submission) => getAnnotationSubmission(submission.id)));
      if (request.current === requestId) setSubmissions(details);
    } catch (caught) {
      if (request.current === requestId) {
        setSubmissions([]);
        setError(caught instanceof Error ? caught.message : "Could not load the moderation queue.");
      }
    } finally {
      if (request.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void loadModeration();
  }, [active, loadModeration]);

  const moderateSubmission = useCallback(async (submissionId: number, status: "approved" | "rejected") => {
    if (moderatingSubmissionId !== null) return;
    setModeratingSubmissionId(submissionId);
    setError("");
    try {
      await moderateAnnotationSubmission(submissionId, status);
      setSubmissions((current) => current.filter((detail) => detail.submission.id !== submissionId));
      setMessage(`Submission #${submissionId} ${status}. Contributions will show the updated status.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not mark the submission as ${status}.`);
      await loadModeration();
    } finally {
      setModeratingSubmissionId(null);
    }
  }, [loadModeration, moderatingSubmissionId]);

  const toggleAnnotationDetails = useCallback((annotationId: number) => {
    setExpandedAnnotationIds((current) => {
      const next = new Set(current);
      if (next.has(annotationId)) next.delete(annotationId);
      else next.add(annotationId);
      return next;
    });
  }, []);

  return {
    submissions,
    loading,
    error,
    message,
    moderatingSubmissionId,
    expandedAnnotationIds,
    loadModeration,
    moderateSubmission,
    toggleAnnotationDetails,
  };
}

export type ModerationState = ReturnType<typeof useModeration>;

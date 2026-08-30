import type { AIProgressResponse, LifecycleJob, RollbackComparisonResponse, UserModelOverview } from "../../types/api";
import { JSON_HEADERS, requestJson } from "./client";

export function getAIProgress(): Promise<AIProgressResponse> {
  return requestJson<AIProgressResponse>("/ai-progress");
}

export function getUserModelOverview(): Promise<UserModelOverview> {
  return requestJson<UserModelOverview>("/models/user-overview");
}

export function getRollbackTargetComparison(version: string): Promise<RollbackComparisonResponse> {
  return requestJson<RollbackComparisonResponse>(
    `/model-lifecycle/rollback-targets/${encodeURIComponent(version)}/compare`,
  );
}

export function startCandidateTraining(submissionIds?: number[]): Promise<LifecycleJob> {
  return requestJson<LifecycleJob>("/model-lifecycle/train", {
    method: "POST",
    ...(submissionIds
      ? {
          headers: JSON_HEADERS,
          body: JSON.stringify({ submission_ids: submissionIds }),
        }
      : {}),
  });
}

export function startCandidateComparison(version: string): Promise<LifecycleJob> {
  return requestJson<LifecycleJob>(
    `/model-lifecycle/candidates/${encodeURIComponent(version)}/compare`,
    { method: "POST" },
  );
}

export function getLifecycleJob(jobId: string): Promise<LifecycleJob> {
  return requestJson<LifecycleJob>(`/model-lifecycle/jobs/${encodeURIComponent(jobId)}`);
}

export function promoteCandidate(version: string, comparisonId: string) {
  return requestJson<{ ok: boolean; active_version: string }>(
    `/models/${encodeURIComponent(version)}/promote`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ comparison_id: comparisonId }),
    },
  );
}

export function rejectCandidate(version: string) {
  return requestJson<{ ok: boolean; model_version: string; quarantined_submission_count: number }>(
    `/models/${encodeURIComponent(version)}/reject`,
    { method: "POST" },
  );
}

export function rollbackModel(version: string) {
  return requestJson<{ ok: boolean; active_version: string }>(
    `/models/${encodeURIComponent(version)}/rollback`,
    { method: "POST" },
  );
}

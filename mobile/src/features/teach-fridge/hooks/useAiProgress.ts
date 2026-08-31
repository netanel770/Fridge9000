import { useCallback, useEffect, useRef, useState } from "react";

import { getAIProgress } from "../../../services/api";
import type { AIProgressResponse } from "../../../types/api";

export function useAiProgress(active: boolean, lifecycleCompletionCount: number) {
  const [stats, setStats] = useState<AIProgressResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showModelDetails, setShowModelDetails] = useState(false);
  const request = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++request.current;
    setLoading(true);
    setError("");
    try {
      const progress = await getAIProgress();
      if (request.current === requestId) {
        setStats(progress);
        setShowModelDetails(false);
      }
    } catch (caught) {
      if (request.current === requestId) {
        setStats(null);
        setError(caught instanceof Error ? caught.message : "Could not load AI progress statistics.");
      }
    } finally {
      if (request.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, lifecycleCompletionCount, load]);

  return { stats, loading, error, load, showModelDetails, setShowModelDetails };
}

export type AiProgressState = ReturnType<typeof useAiProgress>;

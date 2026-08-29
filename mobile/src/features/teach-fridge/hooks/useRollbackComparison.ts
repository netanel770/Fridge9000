import { useCallback, useState } from "react";

import { getRollbackTargetComparison } from "../../../services/api";
import type { RollbackComparisonResponse, RollbackTarget } from "../../../types/api";

export function useRollbackComparison() {
  const [show, setShow] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [target, setTarget] = useState<RollbackTarget | null>(null);
  const [comparison, setComparison] = useState<RollbackComparisonResponse | null>(null);
  const [loadingVersion, setLoadingVersion] = useState<string | null>(null);
  const [error, setError] = useState("");

  const open = useCallback(() => {
    setSelectedVersion(null);
    setTarget(null);
    setComparison(null);
    setError("");
    setShow(true);
  }, []);

  const close = useCallback(() => {
    setShow(false);
  }, []);

  const complete = useCallback(() => {
    setShow(false);
    setSelectedVersion(null);
  }, []);

  const back = useCallback(() => {
    setTarget(null);
    setComparison(null);
    setError("");
  }, []);

  const viewComparison = useCallback(async (rollbackTarget: RollbackTarget) => {
    setLoadingVersion(rollbackTarget.version);
    setError("");
    try {
      const result = await getRollbackTargetComparison(rollbackTarget.version);
      setTarget(rollbackTarget);
      setComparison(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the cached comparison.");
    } finally {
      setLoadingVersion(null);
    }
  }, []);

  return {
    show,
    selectedVersion,
    setSelectedVersion,
    target,
    comparison,
    loadingVersion,
    error,
    open,
    close,
    complete,
    back,
    viewComparison,
  };
}

export type RollbackComparisonState = ReturnType<typeof useRollbackComparison>;

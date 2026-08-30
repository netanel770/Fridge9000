import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { getRecentScans, getScan, getScanDetections } from "../../../services/api";
import type { DetectionItem, RecentScan } from "../../../types/api";

type AddMissedHandler = (scan: RecentScan) => Promise<void>;

export function useSuggestions({
  active = true,
  requestedScanId,
  requestedDetectionId,
  hasValidRequestedScan,
  hasTargetedDetection,
  addMissed,
  addMissedHandler,
  selectionStartHandler,
}: {
  active?: boolean;
  requestedScanId: number;
  requestedDetectionId: number;
  hasValidRequestedScan: boolean;
  hasTargetedDetection: boolean;
  addMissed?: string;
  addMissedHandler: RefObject<AddMissedHandler | null>;
  selectionStartHandler: RefObject<(() => void) | null>;
}) {
  const initialRoute = useRef({ requestedScanId, requestedDetectionId, hasValidRequestedScan, hasTargetedDetection, addMissed }).current;
  const [scans, setScans] = useState<RecentScan[]>([]);
  const [selectedScan, setSelectedScan] = useState<RecentScan | null>(null);
  const [detections, setDetections] = useState<DetectionItem[]>([]);
  const [loadingScans, setLoadingScans] = useState(true);
  const [loadingDetections, setLoadingDetections] = useState(false);
  const [error, setError] = useState("");
  const selectionRequest = useRef(0);
  const handledRequestedScan = useRef(false);

  const selectScan = useCallback(async (scan: RecentScan) => {
    const requestId = ++selectionRequest.current;
    selectionStartHandler.current?.();
    setSelectedScan(scan);
    setLoadingDetections(true);
    setError("");
    try {
      const scanDetections = await getScanDetections(scan.id);
      if (selectionRequest.current === requestId) {
        setDetections(initialRoute.hasTargetedDetection && scan.id === initialRoute.requestedScanId
          ? [...scanDetections].sort((left, right) => Number(right.id === initialRoute.requestedDetectionId) - Number(left.id === initialRoute.requestedDetectionId))
          : scanDetections);
      }
    } catch (caught) {
      if (selectionRequest.current === requestId) {
        setDetections([]);
        setError(caught instanceof Error ? caught.message : "Could not load scan detections.");
      }
    } finally {
      if (selectionRequest.current === requestId) setLoadingDetections(false);
    }
  }, [initialRoute, selectionStartHandler]);

  const loadSuggestions = useCallback(async () => {
    setLoadingScans(true);
    setError("");
    try {
      const [recent, requestedScan] = await Promise.all([
        getRecentScans(10),
        initialRoute.hasValidRequestedScan ? getScan(initialRoute.requestedScanId) : Promise.resolve(undefined),
      ]);
      setScans(requestedScan && !recent.some((scan) => scan.id === requestedScan.id) ? [requestedScan, ...recent] : recent);
      const initialScan = initialRoute.hasValidRequestedScan ? requestedScan : recent[0];
      if (initialScan) {
        await selectScan(initialScan);
        if (requestedScan && initialRoute.addMissed === "1" && !handledRequestedScan.current) {
          handledRequestedScan.current = true;
          await addMissedHandler.current?.(requestedScan);
        }
      } else {
        setSelectedScan(null);
        setDetections([]);
        if (initialRoute.hasValidRequestedScan) setError(`Scan #${initialRoute.requestedScanId} could not be loaded. Return to Review and try again.`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load recent scans.");
    } finally {
      setLoadingScans(false);
    }
  }, [addMissedHandler, initialRoute, selectScan]);

  useEffect(() => {
    if (active) void loadSuggestions();
  }, [active, loadSuggestions]);

  return {
    scans,
    selectedScan,
    detections,
    loadingScans,
    loadingDetections,
    error,
    setError,
    selectScan,
    loadSuggestions,
  };
}

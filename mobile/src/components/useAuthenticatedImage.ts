import { useCallback, useEffect, useRef, useState } from "react";

import { isProtectedApiImageUri, loadProtectedImage, subscribeToApiContextChanges, type LoadedProtectedImage } from "../services/api";

export type AuthenticatedImageStatus = "LOADING" | "LOADED" | "ERROR";

export function useAuthenticatedImage(imageUri: string) {
  const protectedImage = isProtectedApiImageUri(imageUri);
  const [attempt, setAttempt] = useState(0);
  const [resolvedUri, setResolvedUri] = useState<string | null>(protectedImage ? null : imageUri);
  const [status, setStatus] = useState<AuthenticatedImageStatus>("LOADING");
  const statusRef = useRef(status);
  statusRef.current = status;

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => subscribeToApiContextChanges(() => {
    if (statusRef.current !== "LOADING") retry();
  }), [retry]);

  useEffect(() => {
    let active = true;
    let loaded: LoadedProtectedImage | null = null;
    setStatus("LOADING");
    if (!protectedImage) {
      setResolvedUri(imageUri);
      return () => { active = false; };
    }
    setResolvedUri(null);

    void loadProtectedImage(imageUri).then((result) => {
      loaded = result;
      if (!active) {
        void result.release();
        loaded = null;
        return;
      }
      setResolvedUri(result.uri);
    }).catch(() => {
      if (active) setStatus("ERROR");
    });

    return () => {
      active = false;
      if (loaded) void loaded.release();
    };
  }, [attempt, imageUri, protectedImage]);

  return {
    resolvedUri,
    status,
    retry,
    onLoad: () => setStatus("LOADED"),
    onError: () => {
      setResolvedUri(null);
      setStatus("ERROR");
    },
    protected: protectedImage,
  };
}

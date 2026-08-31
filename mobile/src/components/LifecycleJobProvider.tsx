import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import {
  ApiError,
  getActiveLifecycleJob,
  getAIProgress,
  getLifecycleJob,
} from "../services/api";
import type { LifecycleJob } from "../types/api";
import { colors, radius, spacing } from "../theme";

type LifecycleJobContextValue = {
  job: LifecycleJob | null;
  action: string | null;
  message: string;
  error: string;
  completionCount: number;
  busy: boolean;
  runJob: (label: string, start: () => Promise<LifecycleJob>) => Promise<void>;
  clearFeedback: () => void;
};

const LifecycleJobContext = createContext<LifecycleJobContextValue | null>(null);
const LIFECYCLE_POLL_INTERVAL_MS = 2000;

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isActiveLifecycleJob(job: LifecycleJob) {
  return job.status === "queued" || job.status === "running";
}

function lifecycleActionLabel(job: LifecycleJob) {
  return job.kind === "TRAIN" ? "Train Candidate" : "Compare Models";
}

function lifecycleJobIdFromTrainingRunId(trainingRunId: string) {
  if (trainingRunId.startsWith("remote-lifecycle-")) {
    return trainingRunId.slice("remote-".length);
  }

  if (trainingRunId.startsWith("lifecycle-")) {
    return trainingRunId;
  }

  return null;
}

export function lifecyclePhaseLabel(job: LifecycleJob) {
  if (job.phase === "preparing") return "Preparing training data";
  if (job.phase === "uploading") return "Uploading to Kaggle";
  if (job.phase === "waiting_for_dataset") return "Preparing remote dataset";
  if (job.phase === "queued" || job.status === "queued") return "Waiting for GPU";
  if (job.phase === "running") return job.kind === "TRAIN" ? "Training candidate" : "Comparing models";
  if (job.phase === "downloading") return "Downloading results";
  if (job.phase === "registering") return "Registering candidate";
  return "Working in background";
}

function conciseLifecycleError(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) return "The model job failed. Please try again.";
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

async function discoverActiveLifecycleJob(): Promise<LifecycleJob | null> {
  try {
    return await getActiveLifecycleJob();
  } catch (caught) {
    if (!(caught instanceof ApiError) || caught.status !== 404) {
      throw caught;
    }
  }

  // Compatibility fallback for a backend that has not yet been restarted with
  // the new /model-lifecycle/active endpoint.
  const progress = await getAIProgress();
  const activeRun = progress.training_history.find((run) => run.status === "running");

  if (!activeRun) return null;

  const jobId = lifecycleJobIdFromTrainingRunId(activeRun.training_run_id);
  if (!jobId) return null;

  try {
    return await getLifecycleJob(jobId);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) {
      return null;
    }
    throw caught;
  }
}

export function LifecycleJobProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<LifecycleJob | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [completionCount, setCompletionCount] = useState(0);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const trackingGenerationRef = useRef(0);
  const busy = Boolean(action);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      trackingGenerationRef.current += 1;
    };
  }, []);

  const trackJob = useCallback(async (initial: LifecycleJob, label: string) => {
    const generation = ++trackingGenerationRef.current;
    let current = initial;
    let missingJob = false;

    if (!mountedRef.current) return;

    setJob(current);

    while (
      isActiveLifecycleJob(current)
      && mountedRef.current
      && trackingGenerationRef.current === generation
    ) {
      await sleep(LIFECYCLE_POLL_INTERVAL_MS);

      if (
        !mountedRef.current
        || trackingGenerationRef.current !== generation
      ) {
        return;
      }

      try {
        current = await getLifecycleJob(current.job_id);

        if (
          !mountedRef.current
          || trackingGenerationRef.current !== generation
        ) {
          return;
        }

        setJob(current);
        setError("");
      } catch (caught) {
        if (
          !mountedRef.current
          || trackingGenerationRef.current !== generation
        ) {
          return;
        }

        if (caught instanceof ApiError && caught.status === 404) {
          missingJob = true;
          setJob(null);
          setError(
            "This lifecycle job can no longer be found. The backend may have restarted. Refresh AI Progress to recheck the current model state.",
          );
          break;
        }

        setError("Connection interrupted. Still checking the current lifecycle job.");
      }
    }

    if (
      missingJob
      || !mountedRef.current
      || trackingGenerationRef.current !== generation
    ) {
      return;
    }

    if (current.status === "failed") {
      throw new Error(
        conciseLifecycleError(current.error?.message || `${label} failed.`),
      );
    }

    if (current.kind === "COMPARE" && current.result?.auto_rejected === true) {
      const quarantined = Number(current.result.quarantined_submission_count || 0);
      setMessage(
        `Candidate did not meet the criteria. ${quarantined} submission${quarantined === 1 ? " was" : "s were"} quarantined.`,
      );
    } else {
      setMessage(`${label} completed successfully.`);
    }
  }, []);

  async function runJob(label: string, start: () => Promise<LifecycleJob>) {
    if (busyRef.current) return;

    busyRef.current = true;
    setAction(label);
    setMessage("");
    setError("");

    try {
      const current = await start();
      await trackJob(current, label);
    } catch (caught) {
      if (mountedRef.current) {
        setError(
          conciseLifecycleError(
            caught instanceof Error ? caught.message : `${label} failed.`,
          ),
        );
      }
    } finally {
      busyRef.current = false;

      if (mountedRef.current) {
        setAction(null);
        setCompletionCount((count) => count + 1);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function recoverActiveJob() {
      try {
        const active = await discoverActiveLifecycleJob();

        if (
          cancelled
          || !mountedRef.current
          || !active
          || !isActiveLifecycleJob(active)
          || busyRef.current
        ) {
          return;
        }

        const label = lifecycleActionLabel(active);
        busyRef.current = true;
        setAction(label);
        setMessage("");
        setError("");
        setJob(active);

        try {
          await trackJob(active, label);
        } catch (caught) {
          if (!cancelled && mountedRef.current) {
            setError(
              conciseLifecycleError(
                caught instanceof Error ? caught.message : `${label} failed.`,
              ),
            );
          }
        } finally {
          busyRef.current = false;

          if (!cancelled && mountedRef.current) {
            setAction(null);
            setCompletionCount((count) => count + 1);
          }
        }
      } catch {
        // Recovery is best-effort. Logged-out sessions, non-admin users, or a
        // temporarily unavailable backend should not produce lifecycle noise.
      }
    }

    void recoverActiveJob();

    return () => {
      cancelled = true;
    };
  }, [trackJob]);

  const value = useMemo(() => ({
    job,
    action,
    message,
    error,
    completionCount,
    busy,
    runJob,
    clearFeedback: () => {
      setMessage("");
      setError("");
    },
  }), [action, busy, completionCount, error, job, message]);

  const trainingActive =
    job?.kind === "TRAIN"
    && (job.status === "queued" || job.status === "running");

  return (
    <LifecycleJobContext.Provider value={value}>
      <View style={styles.root}>
        {children}
        {trainingActive ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Training new AI model. ${lifecyclePhaseLabel(job)}. Active model remains in use. View progress.`}
            onPress={() => router.push({ pathname: "/teach-fridge", params: { tab: "AI Progress" } })}
            style={({ pressed }) => [styles.banner, pressed && styles.bannerPressed]}
          >
            <ActivityIndicator color={colors.primaryText} />
            <View style={styles.copy}>
              <Text style={styles.title}>Training new AI model</Text>
              <Text style={styles.meta}>
                {lifecyclePhaseLabel(job)} · Active model still in use
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.primaryText} />
          </Pressable>
        ) : null}
      </View>
    </LifecycleJobContext.Provider>
  );
}

export function useLifecycleJob() {
  const context = useContext(LifecycleJobContext);
  if (!context) throw new Error("useLifecycleJob must be used within LifecycleJobProvider");
  return context;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  banner: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.xl,
    backgroundColor: colors.navy,
    shadowColor: colors.navy,
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
  },
  bannerPressed: { opacity: 0.9 },
  copy: { flex: 1, gap: 2 },
  title: { color: colors.primaryText, fontSize: 14, fontWeight: "900" },
  meta: {
    color: "#dbeafe",
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
});

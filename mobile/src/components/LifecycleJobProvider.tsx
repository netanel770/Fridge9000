import { createContext, type ReactNode, useContext, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { getLifecycleJob } from "../services/api";
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

export function LifecycleJobProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<LifecycleJob | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [completionCount, setCompletionCount] = useState(0);
  const busyRef = useRef(false);
  const busy = Boolean(action);

  async function runJob(label: string, start: () => Promise<LifecycleJob>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setAction(label);
    setMessage("");
    setError("");
    try {
      let current = await start();
      setJob(current);
      while (current.status === "queued" || current.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        try {
          current = await getLifecycleJob(current.job_id);
          setJob(current);
          setError("");
        } catch {
          setError("Connection interrupted. Still checking the current lifecycle job.");
        }
      }
      if (current.status === "failed") throw new Error(conciseLifecycleError(current.error?.message || `${label} failed.`));
      if (current.kind === "COMPARE" && current.result?.auto_rejected === true) {
        const quarantined = Number(current.result.quarantined_submission_count || 0);
        setMessage(`Candidate did not meet the criteria. ${quarantined} submission${quarantined === 1 ? " was" : "s were"} quarantined.`);
      } else {
        setMessage(`${label} completed successfully.`);
      }
    } catch (caught) {
      setError(conciseLifecycleError(caught instanceof Error ? caught.message : `${label} failed.`));
    } finally {
      busyRef.current = false;
      setAction(null);
      setCompletionCount((count) => count + 1);
    }
  }

  const value = useMemo(() => ({
    job,
    action,
    message,
    error,
    completionCount,
    busy,
    runJob,
    clearFeedback: () => { setMessage(""); setError(""); },
  }), [action, busy, completionCount, error, job, message]);

  const trainingActive = job?.kind === "TRAIN" && (job.status === "queued" || job.status === "running");
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
              <Text style={styles.meta}>{lifecyclePhaseLabel(job)} · Active model still in use</Text>
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
  banner: { position: "absolute", left: spacing.md, right: spacing.md, bottom: spacing.md, minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, borderRadius: radius.xl, backgroundColor: colors.navy, shadowColor: colors.navy, shadowOpacity: 0.22, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 8 },
  bannerPressed: { opacity: 0.9 },
  copy: { flex: 1, gap: 2 },
  title: { color: colors.primaryText, fontSize: 14, fontWeight: "900" },
  meta: { color: "#dbeafe", fontSize: 12, lineHeight: 17, fontWeight: "600" },
});

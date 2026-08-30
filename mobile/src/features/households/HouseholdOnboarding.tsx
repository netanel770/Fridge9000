import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { AppButton, Card, EmptyState, ScreenHeader, StatusBadge } from "../../components/ui";
import { createHousehold, joinHousehold } from "../../services/api";
import { colors, radius, spacing } from "../../theme";
import { useHousehold } from "./HouseholdContext";

export function HouseholdOnboarding() {
  const household = useHousehold();
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | "refresh" | null>(null);
  const [error, setError] = useState("");

  async function create() {
    if (!name.trim()) { setError("Enter a household name."); return; }
    setBusy("create"); setError("");
    try {
      const created = await createHousehold(name.trim());
      await household.refresh(created.id);
      router.replace("/");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create the household."); }
    finally { setBusy(null); }
  }

  async function join() {
    if (!joinCode.trim()) { setError("Enter a join code."); return; }
    setBusy("join"); setError("");
    try { await joinHousehold(joinCode.trim()); await household.refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not request membership."); }
    finally { setBusy(null); }
  }

  async function refresh() {
    setBusy("refresh"); setError("");
    try {
      await household.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not refresh membership status."); }
    finally { setBusy(null); }
  }

  return <View style={styles.content}>
    <ScreenHeader eyebrow="Household setup" title="Connect your fridge" subtitle="Create a household or ask to join an existing one." />
    {household.pendingMemberships.length ? <Card><View style={styles.stack}><StatusBadge label="PENDING APPROVAL" tone="warning" /><Text style={styles.cardTitle}>Waiting for approval</Text>{household.pendingMemberships.map((item) => <Text key={item.fridge_id} style={styles.meta}>{item.fridge_name} · {item.role}</Text>)}<AppButton label="Refresh approval status" icon="refresh" variant="secondary" loading={busy === "refresh"} onPress={() => { void refresh(); }} /></View></Card> : null}
    <Card><View style={styles.stack}><Text style={styles.cardTitle}>Create a household</Text><TextInput value={name} onChangeText={setName} placeholder="Household or fridge name" style={styles.input} /><AppButton label="Create household" icon="add-circle-outline" loading={busy === "create"} disabled={busy !== null} onPress={() => { void create(); }} /></View></Card>
    <Card><View style={styles.stack}><Text style={styles.cardTitle}>Join with a code</Text><TextInput value={joinCode} onChangeText={setJoinCode} autoCapitalize="characters" autoCorrect={false} placeholder="Join code" style={styles.input} /><AppButton label="Request to join" icon="people-outline" variant="secondary" loading={busy === "join"} disabled={busy !== null} onPress={() => { void join(); }} /></View></Card>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {!household.pendingMemberships.length ? <EmptyState icon="home-outline" title="No active household yet" message="Household data stays unavailable until you create one or an owner approves your request." /> : null}
  </View>;
}

const styles = StyleSheet.create({ content: { gap: spacing.lg }, stack: { gap: spacing.md }, cardTitle: { color: colors.navy, fontSize: 18, fontWeight: "900" }, meta: { color: colors.textMuted }, input: { minHeight: 50, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, paddingHorizontal: spacing.md, backgroundColor: colors.surface, color: colors.textPrimary }, error: { color: colors.danger, backgroundColor: colors.dangerBg, padding: spacing.md, borderRadius: radius.lg, fontWeight: "600" } });

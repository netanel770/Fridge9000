import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from "react-native";

import { AppButton, Card, EmptyState, ScreenHeader, StatusBadge } from "../../components/ui";
import { getSystemAdmins, grantSystemAdmin } from "../../services/api";
import { colors, radius, spacing } from "../../theme";
import type { PublicUser } from "../../types/api";
import { useAuth } from "../auth/AuthContext";

export function SystemAdminManagement() {
  const { user } = useAuth();
  const [admins, setAdmins] = useState<PublicUser[]>([]);
  const [targetId, setTargetId] = useState("");
  const [loading, setLoading] = useState(true);
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    if (!user?.is_system_admin) return;
    setLoading(true); setError("");
    try { setAdmins(await getSystemAdmins()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load system admins."); }
    finally { setLoading(false); }
  }, [user?.is_system_admin]);
  useEffect(() => { void load(); }, [load]);
  if (!user?.is_system_admin) return <EmptyState icon="lock-closed-outline" title="System admin access required" message="Household roles do not grant global administration." />;
  async function grant() {
    const id = Number(targetId);
    if (!Number.isInteger(id) || id <= 0) { setError("Enter a valid registered user ID."); return; }
    setGranting(true); setError(""); setMessage("");
    try { const granted = await grantSystemAdmin(id); setMessage(`${granted.email} is now a system admin.`); setTargetId(""); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not grant system admin access."); }
    finally { setGranting(false); }
  }
  return <View style={styles.content}>
    <ScreenHeader eyebrow="System administration" title="System Admins" subtitle="View global administrators and grant access to an active registered user." />
    <Card><View style={styles.stack}><Text style={styles.title}>Grant SYSTEM_ADMIN</Text><Text style={styles.meta}>The backend currently grants by user ID. No global user directory is exposed.</Text><TextInput value={targetId} onChangeText={setTargetId} keyboardType="number-pad" placeholder="Registered user ID" style={styles.input} /><AppButton label="Grant system admin" icon="shield-checkmark-outline" loading={granting} onPress={() => { void grant(); }} /></View></Card>
    {message ? <Text style={styles.success}>{message}</Text> : null}{error ? <Text style={styles.error}>{error}</Text> : null}
    <Text style={styles.title}>Current system admins</Text>
    {loading ? <ActivityIndicator color={colors.primary} /> : admins.map((admin) => <Card key={admin.id}><View style={styles.row}><View style={styles.copy}><Text style={styles.name}>{admin.display_name || admin.email}</Text><Text style={styles.meta}>{admin.email} · User #{admin.id}</Text></View><StatusBadge label="SYSTEM_ADMIN" tone="info" /></View></Card>)}
  </View>;
}

const styles = StyleSheet.create({ content: { gap: spacing.lg }, stack: { gap: spacing.md }, title: { color: colors.navy, fontSize: 18, fontWeight: "900" }, meta: { color: colors.textMuted, fontSize: 13, lineHeight: 18 }, input: { minHeight: 50, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, paddingHorizontal: spacing.md, backgroundColor: colors.surface, color: colors.textPrimary }, row: { flexDirection: "row", alignItems: "center", gap: spacing.md }, copy: { flex: 1 }, name: { color: colors.navy, fontWeight: "900" }, success: { color: colors.successFg, backgroundColor: colors.successBg, padding: spacing.md, borderRadius: radius.lg, fontWeight: "700" }, error: { color: colors.danger, backgroundColor: colors.dangerBg, padding: spacing.md, borderRadius: radius.lg, fontWeight: "600" } });

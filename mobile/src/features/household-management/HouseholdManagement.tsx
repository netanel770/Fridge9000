import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { AppButton, Card, EmptyState, ScreenHeader, StatusBadge } from "../../components/ui";
import { colors, spacing } from "../../theme";
import type { HouseholdMember } from "../../types/api";
import { useHousehold } from "../households/HouseholdContext";
import { useHouseholdMembers } from "./useHouseholdMembers";

export function HouseholdManagement() {
  const household = useHousehold();
  const membership = household.selected;
  const canManage = Boolean(membership && ["OWNER", "MANAGER"].includes(membership.role));
  const state = useHouseholdMembers(canManage ? membership?.fridge_id : undefined);
  if (!membership || !canManage) return <EmptyState icon="lock-closed-outline" title="Manager access required" message="Only the selected household's owner or manager can manage members." />;
  const pending = state.data?.members.filter((item) => item.status === "PENDING") || [];
  const active = state.data?.members.filter((item) => item.status === "ACTIVE") || [];
  return <View style={styles.content}>
    <ScreenHeader eyebrow="Household management" title={membership.fridge_name} subtitle="Review join requests and active household members." />
    <Card><View style={styles.stack}><Text style={styles.caption}>JOIN CODE</Text><Text selectable style={styles.code}>{state.data?.join_code || "Unavailable"}</Text><Text style={styles.meta}>Share this code only with people you want to invite.</Text></View></Card>
    {state.loading ? <ActivityIndicator color={colors.primary} /> : null}
    {state.error ? <View style={styles.error}><Text style={styles.errorText}>{state.error}</Text><AppButton label="Try again" variant="secondary" onPress={() => { void state.load(); }} /></View> : null}
    <Text style={styles.heading}>Pending requests</Text>
    {!state.loading && !pending.length ? <Card><EmptyState icon="checkmark-circle-outline" title="No pending requests" message="New join requests will appear here." /></Card> : pending.map((member) => <MemberCard key={member.user_id} member={member} acting={state.actingUserId === member.user_id} onAction={state.act} pending />)}
    <Text style={styles.heading}>Active members</Text>
    {active.map((member) => <MemberCard key={member.user_id} member={member} acting={state.actingUserId === member.user_id} onAction={state.act} pending={false} canRemove={member.role !== "OWNER" && !(membership.role === "MANAGER" && member.role !== "MEMBER")} />)}
  </View>;
}

function MemberCard({ member, pending, acting, canRemove = false, onAction }: { member: HouseholdMember; pending: boolean; acting: boolean; canRemove?: boolean; onAction: (id: number, action: "approve" | "reject" | "remove") => Promise<void> }) {
  return <Card><View style={styles.stack}><View style={styles.memberHeader}><View style={styles.copy}><Text style={styles.memberName}>{member.display_name || member.email}</Text>{member.display_name ? <Text style={styles.meta}>{member.email}</Text> : null}</View><StatusBadge label={member.role} tone={member.role === "OWNER" ? "info" : "neutral"} /></View>{pending ? <View style={styles.actions}><View style={styles.action}><AppButton label="Approve" loading={acting} onPress={() => { void onAction(member.user_id, "approve"); }} /></View><View style={styles.action}><AppButton label="Reject" variant="danger" disabled={acting} onPress={() => { void onAction(member.user_id, "reject"); }} /></View></View> : canRemove ? <AppButton label="Remove member" variant="danger" loading={acting} onPress={() => { void onAction(member.user_id, "remove"); }} /> : null}</View></Card>;
}

const styles = StyleSheet.create({ content: { gap: spacing.lg }, stack: { gap: spacing.sm }, caption: { color: colors.textMuted, fontSize: 11, fontWeight: "900", letterSpacing: 1 }, code: { color: colors.primary, fontSize: 25, fontWeight: "900", letterSpacing: 2 }, meta: { color: colors.textMuted, fontSize: 13, lineHeight: 18 }, heading: { color: colors.navy, fontSize: 19, fontWeight: "900" }, memberHeader: { flexDirection: "row", alignItems: "center", gap: spacing.md }, copy: { flex: 1 }, memberName: { color: colors.navy, fontWeight: "900", fontSize: 16 }, actions: { flexDirection: "row", gap: spacing.sm }, action: { flex: 1 }, error: { gap: spacing.sm, backgroundColor: colors.dangerBg, padding: spacing.md }, errorText: { color: colors.danger, fontWeight: "600" } });

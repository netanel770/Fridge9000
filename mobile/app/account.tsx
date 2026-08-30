import { router } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { AppButton, Card, ScreenHeader, StatusBadge } from "../src/components/ui";
import { useAuth } from "../src/features/auth/AuthContext";
import { useHousehold } from "../src/features/households/HouseholdContext";
import { colors, spacing } from "../src/theme";

export default function AccountScreen() {
  const auth = useAuth(); const household = useHousehold();
  return <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
    <ScreenHeader eyebrow="Fridge9000" title={`Hello, ${auth.user?.display_name || auth.user?.email || "there"}`} subtitle="Choose how you want to continue." />
    {auth.user?.is_system_admin ? <Card><View style={styles.stack}><StatusBadge label="SYSTEM ADMIN" tone="info" /><Text style={styles.title}>Global AI administration</Text><Text style={styles.meta}>System administration is independent from household membership.</Text><AppButton label="Open Admin Teach AI" icon="school-outline" onPress={() => router.push("/teach-fridge")} /><AppButton label="Manage system admins" variant="secondary" icon="shield-checkmark-outline" onPress={() => router.push("/system-admins" as never)} /></View></Card> : null}
    {household.activeMemberships.length ? <Card><View style={styles.stack}><Text style={styles.title}>Choose a household</Text><Text style={styles.meta}>Household data is loaded only after you select an active membership.</Text>{household.activeMemberships.map((membership) => <AppButton key={membership.fridge_id} label={`${membership.fridge_name} · ${membership.role}`} variant="secondary" onPress={() => { void household.selectHousehold(membership.fridge_id); }} />)}</View></Card> : null}
    <Card><View style={styles.stack}><Text style={styles.title}>Household access</Text><Text style={styles.meta}>{household.pendingMemberships.length ? "Your join request is waiting for approval." : "Create or join a household to use fridge data."}</Text><AppButton label="Household setup" icon="home-outline" variant="secondary" onPress={() => router.push("/household-onboarding" as never)} /></View></Card>
    <AppButton label="Sign out" icon="log-out-outline" variant="ghost" onPress={() => { void auth.signOut(); }} />
  </ScrollView>;
}
const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.background }, container: { padding: spacing.xl, gap: spacing.lg }, stack: { gap: spacing.md }, title: { color: colors.navy, fontSize: 18, fontWeight: "900" }, meta: { color: colors.textMuted, lineHeight: 20 } });

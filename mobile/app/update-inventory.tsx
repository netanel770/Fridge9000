import { useEffect } from "react";
import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { startOutlinePreparation } from "../src/services/api";
import { AppButton, ScreenHeader, SectionTitle } from "../src/components/ui";
import { colors, radius, spacing } from "../src/theme";

export default function UpdateInventoryMenuScreen() {
  useEffect(() => {
    startOutlinePreparation(true).catch(() => {
      // Best-effort preloading; the open-products flow displays actionable errors.
    });
  }, []);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <ScreenHeader eyebrow="Inventory" title="What changed?" subtitle="Scan products for the quickest update, or choose another method." />

      <View style={styles.hero}>
        <View style={styles.heroIcon}><Ionicons name="scan" size={34} color={colors.primaryText} /></View>
        <Text style={styles.heroTitle}>Scan products</Text>
        <Text style={styles.heroText}>Photograph only the products you are adding or removing. Your inventory remains cumulative.</Text>
        <AppButton label="Start a product scan" icon="camera-outline" onPress={() => router.push("/image-inventory")} />
      </View>

      <SectionTitle title="More ways to update" />
      <View style={styles.optionList}>
        <Option icon="receipt-outline" title="Upload receipt" text="Add purchased products from a receipt." onPress={() => router.push("/receipt-upload")} />
        <Option icon="create-outline" title="Manual update" text="Add or remove a specific product and expiry batch." onPress={() => router.push("/manual-inventory")} />
        <Option icon="calendar-outline" title="Review expired products" text="Remove expired batches or correct an estimated date." onPress={() => router.push("/expired-items")} tone="danger" />
      </View>

      <View style={styles.note}><Ionicons name="information-circle-outline" size={20} color={colors.primary} /><Text style={styles.noteText}>Product outlines are prepared quietly in the background, so adjusting open products is faster later.</Text></View>
    </ScrollView>
  );
}

function Option({ icon, title, text, onPress, tone = "default" }: { icon: keyof typeof Ionicons.glyphMap; title: string; text: string; onPress: () => void; tone?: "default" | "danger" }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.option, pressed && styles.pressed]}><View style={[styles.optionIcon, tone === "danger" && styles.dangerIcon]}><Ionicons name={icon} size={23} color={tone === "danger" ? colors.danger : colors.primary} /></View><View style={styles.optionCopy}><Text style={styles.optionTitle}>{title}</Text><Text style={styles.optionText}>{text}</Text></View><Ionicons name="chevron-forward" size={20} color={colors.textMuted} /></Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, container: { padding: spacing.xl, gap: spacing.lg, paddingBottom: 44 },
  hero: { borderRadius: 22, backgroundColor: colors.navy, padding: spacing.xl, gap: spacing.md, overflow: "hidden" }, heroIcon: { width: 58, height: 58, borderRadius: 18, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }, heroTitle: { color: colors.primaryText, fontSize: 24, fontWeight: "800" }, heroText: { color: "#cbd5e1", lineHeight: 21, marginBottom: spacing.xs },
  optionList: { gap: spacing.sm }, option: { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: spacing.md }, optionIcon: { width: 48, height: 48, borderRadius: 15, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" }, dangerIcon: { backgroundColor: colors.dangerBg }, optionCopy: { flex: 1 }, optionTitle: { fontSize: 16, fontWeight: "800", color: colors.navy }, optionText: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginTop: 3 }, pressed: { opacity: 0.7 },
  note: { backgroundColor: colors.infoBg, borderRadius: radius.lg, padding: spacing.md, flexDirection: "row", gap: spacing.sm }, noteText: { flex: 1, color: colors.infoFg, fontSize: 13, lineHeight: 18 },
});

import type { ComponentProps, ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing, typography } from "../theme";

type IconName = ComponentProps<typeof Ionicons>["name"];

export function ScreenHeader({ eyebrow, title, subtitle }: { eyebrow?: string; title: string; subtitle?: string }) {
  return (
    <View style={styles.header}>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function SectionTitle({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action && onAction ? <Pressable onPress={onAction} hitSlop={8}><Text style={styles.sectionAction}>{action}</Text></Pressable> : null}
    </View>
  );
}

export function AppButton({ label, icon, onPress, variant = "primary", disabled = false, loading = false }: {
  label: string; icon?: IconName; onPress: () => void; variant?: "primary" | "secondary" | "danger" | "ghost"; disabled?: boolean; loading?: boolean;
}) {
  const buttonVariantStyle = variant === "primary"
    ? styles.primaryButton
    : variant === "secondary"
      ? styles.secondaryButton
      : variant === "danger"
        ? styles.dangerButton
        : styles.ghostButton;
  const textVariantStyle = variant === "primary"
    ? styles.primaryText
    : variant === "secondary"
      ? styles.secondaryText
      : variant === "danger"
        ? styles.dangerText
        : styles.ghostText;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || loading, busy: loading }} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [
      styles.button, buttonVariantStyle, (pressed || disabled) && styles.buttonPressed,
    ]}>
      {loading ? <ActivityIndicator color={variant === "primary" || variant === "danger" ? colors.primaryText : colors.primary} /> : icon ? <Ionicons name={icon} size={19} color={variant === "primary" || variant === "danger" ? colors.primaryText : variant === "ghost" ? colors.textSecondary : colors.primary} /> : null}
      <Text style={[styles.buttonText, textVariantStyle]}>{label}</Text>
    </Pressable>
  );
}

export function StatusBadge({ label, tone = "info" }: { label: string; tone?: "info" | "success" | "warning" | "danger" | "neutral" }) {
  const badgeStyle = tone === "info" ? styles.infoBadge : tone === "success" ? styles.successBadge : tone === "warning" ? styles.warningBadge : tone === "danger" ? styles.dangerBadge : styles.neutralBadge;
  const textStyle = tone === "info" ? styles.infoBadgeText : tone === "success" ? styles.successBadgeText : tone === "warning" ? styles.warningBadgeText : tone === "danger" ? styles.dangerBadgeText : styles.neutralBadgeText;
  return <View style={[styles.badge, badgeStyle]}><Text style={[styles.badgeText, textStyle]}>{label}</Text></View>;
}

export function EmptyState({ icon = "checkmark-circle-outline", title, message, action, onAction }: { icon?: IconName; title: string; message: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}><Ionicons name={icon} size={30} color={colors.primary} /></View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyMessage}>{message}</Text>
      {action && onAction ? <AppButton label={action} onPress={onAction} variant="secondary" /> : null}
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs, marginBottom: spacing.sm },
  eyebrow: { color: colors.primary, fontWeight: "800", fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase" },
  title: { ...typography.title, color: colors.navy },
  subtitle: { ...typography.body, color: colors.textMuted, lineHeight: 21 },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md },
  sectionTitle: { ...typography.section, color: colors.navy },
  sectionAction: { color: colors.primary, fontWeight: "700" },
  button: { minHeight: 48, paddingHorizontal: spacing.lg, borderRadius: radius.lg, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, borderWidth: 1 },
  primaryButton: { backgroundColor: colors.primary, borderColor: colors.primary },
  secondaryButton: { backgroundColor: colors.primarySoft, borderColor: "#bfdbfe" },
  dangerButton: { backgroundColor: colors.danger, borderColor: colors.danger },
  ghostButton: { backgroundColor: "transparent", borderColor: colors.border },
  buttonPressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
  buttonText: { ...typography.button, textAlign: "center", flexShrink: 1 },
  primaryText: { color: colors.primaryText }, secondaryText: { color: colors.primary }, dangerText: { color: colors.primaryText }, ghostText: { color: colors.textSecondary },
  badge: { alignSelf: "flex-start", maxWidth: "100%", paddingHorizontal: 9, paddingVertical: 5, borderRadius: radius.pill },
  badgeText: { ...typography.badge, flexShrink: 1 },
  infoBadge: { backgroundColor: colors.infoBg }, infoBadgeText: { color: colors.infoFg },
  successBadge: { backgroundColor: colors.successBg }, successBadgeText: { color: colors.successFg },
  warningBadge: { backgroundColor: colors.warningBg }, warningBadgeText: { color: colors.warningFg },
  dangerBadge: { backgroundColor: colors.dangerBg }, dangerBadgeText: { color: colors.danger },
  neutralBadge: { backgroundColor: colors.surfaceMuted }, neutralBadgeText: { color: colors.textSecondary },
  empty: { padding: spacing.xxl, alignItems: "center", gap: spacing.sm },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center", marginBottom: spacing.xs },
  emptyTitle: { ...typography.section, color: colors.navy, textAlign: "center" },
  emptyMessage: { ...typography.body, color: colors.textMuted, textAlign: "center", lineHeight: 21, marginBottom: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, shadowColor: colors.navy, shadowOpacity: 0.05, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
});

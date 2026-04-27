import { StyleSheet } from "react-native";
import { colors, radius, spacing, typography } from "../../theme";

export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scrollContent: { padding: spacing.xl, gap: spacing.md, paddingBottom: 120 },
  title: { ...typography.title, color: colors.textPrimary },
  subtitle: { ...typography.subtitle, color: colors.textMuted },

  pickerRow: { flexDirection: "row", gap: spacing.sm },
  pickerBtn: {
    flex: 1,
    backgroundColor: colors.ghost,
    paddingVertical: 14,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  pickerBtnText: { ...typography.button, color: colors.textPrimary },

  primaryBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  primaryBtnText: { ...typography.button, color: colors.primaryText },
  primaryBtnDisabled: { opacity: 0.6 },

  successBtn: {
    backgroundColor: colors.success,
    paddingVertical: 14,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  successBtnText: { ...typography.button, color: colors.primaryText },

  ghostBtn: {
    backgroundColor: colors.ghost,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  ghostBtnText: { ...typography.body, color: colors.textPrimary },

  hint: { ...typography.hint, color: colors.textHint },
  caption: { ...typography.caption, color: colors.textHint },

  optionsRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.lg },
  optionLabel: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  optionText: { ...typography.body, color: colors.textSecondary },

  selectedFile: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  selectedFileText: { ...typography.body, color: colors.textSecondary },

  errorBox: {
    padding: spacing.md,
    backgroundColor: colors.dangerBg,
    borderRadius: radius.md,
  },
  errorText: { color: colors.danger, ...typography.body },

  successBox: {
    padding: spacing.md,
    backgroundColor: colors.successBg,
    borderRadius: radius.md,
  },
  successText: { color: colors.successFg, ...typography.body },

  progressWrap: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.surface,
  },
  progressLabelRow: { flexDirection: "row", alignItems: "center" },
  progressStage: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  progressMessage: {
    ...typography.body,
    color: colors.textSecondary,
    flex: 1,
    marginLeft: spacing.sm,
  },
  progressPercent: { ...typography.caption, color: colors.textHint },
  progressBarOuter: {
    height: 8,
    backgroundColor: colors.ghost,
    borderRadius: 4,
    overflow: "hidden",
  },
  progressBarInner: {
    height: "100%",
    backgroundColor: colors.primary,
  },

  itemsHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  itemsHeaderText: { ...typography.body, color: colors.textPrimary, fontWeight: "700" },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  badgeText: { ...typography.badge },
  badgePdf: { backgroundColor: colors.infoBg },
  badgePdfText: { color: colors.infoFg },
  badgeOcr: { backgroundColor: colors.warningBg },
  badgeOcrText: { color: colors.warningFg },
  badgeTableFound: { backgroundColor: colors.successBg },
  badgeTableFoundText: { color: colors.successFg },
  badgeTableMissing: { backgroundColor: colors.dangerBg },
  badgeTableMissingText: { color: colors.danger },

  list: { flexGrow: 0 },
  listContent: { gap: spacing.sm, paddingBottom: spacing.sm },
  rowCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  rowTopRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rowFieldRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  rowLabel: { ...typography.caption, color: colors.textSecondary, width: 60 },
  rowInput: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    minHeight: 44,
    color: colors.textPrimary,
  },
  qtyInput: { width: 100 },
  rowPrice: { ...typography.body, color: colors.textSecondary },

  toolbar: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  toolbarBtn: { flex: 1 },

  rawBox: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    fontFamily: "Courier",
    color: colors.textPrimary,
    ...typography.caption,
  },
});

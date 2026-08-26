import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, radius, spacing, typography } from "../theme";

type ProductLabelInputProps = {
  value: string;
  onChangeText: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  error?: boolean;
  accessibilityLabel?: string;
};

function normalized(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function uniqueProductLabels(labels: (string | null | undefined)[]) {
  const unique = new Map<string, string>();
  labels.forEach((label) => {
    const display = label?.trim();
    if (display && !unique.has(normalized(display))) unique.set(normalized(display), display);
  });
  return [...unique.values()];
}

export function ProductLabelInput({
  value,
  onChangeText,
  suggestions,
  placeholder = "Product label",
  autoFocus = false,
  disabled = false,
  error = false,
  accessibilityLabel = "Product label",
}: ProductLabelInputProps) {
  const [focused, setFocused] = useState(false);
  const matches = useMemo(() => {
    const query = normalized(value);
    return uniqueProductLabels(suggestions)
      .filter((label) => normalized(label) !== query)
      .map((label, index) => {
        const candidate = normalized(label);
        const match = !query ? 2 : candidate.startsWith(query) ? 0 : candidate.includes(query) ? 1 : 3;
        return { label, match, index };
      })
      .filter((item) => item.match < 3)
      .sort((left, right) => left.match - right.match || left.index - right.index || left.label.localeCompare(right.label))
      .slice(0, 5);
  }, [suggestions, value]);
  const showSuggestions = focused && !disabled && matches.length > 0;

  return (
    <View style={styles.container}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="words"
        autoCorrect={false}
        autoFocus={autoFocus}
        editable={!disabled}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.input, error && styles.inputError, disabled && styles.inputDisabled]}
      />
      {showSuggestions ? (
        <View style={styles.suggestions} accessibilityLabel="Product label suggestions">
          {matches.map(({ label }) => (
            <Pressable
              key={normalized(label)}
              accessibilityRole="button"
              accessibilityLabel={`Use product label ${label}`}
              onPressIn={() => onChangeText(label)}
              onPress={() => setFocused(false)}
              style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
            >
              <Ionicons name="cube-outline" size={17} color={colors.primary} />
              <Text style={styles.suggestionText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, paddingHorizontal: spacing.md, backgroundColor: colors.surface, color: colors.textPrimary, fontSize: 16 },
  inputError: { borderColor: colors.danger },
  inputDisabled: { backgroundColor: colors.surfaceMuted, color: colors.textMuted },
  suggestions: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface, overflow: "hidden" },
  suggestion: { minHeight: 44, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  suggestionPressed: { backgroundColor: colors.primarySoft },
  suggestionText: { ...typography.body, color: colors.textPrimary, flex: 1, flexWrap: "wrap" },
});

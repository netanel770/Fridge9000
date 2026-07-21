import type { TextStyle } from "react-native";

export const typography = {
  display: { fontSize: 32, fontWeight: "800", letterSpacing: -0.6 } satisfies TextStyle,
  title: { fontSize: 28, fontWeight: "800", letterSpacing: -0.4 } satisfies TextStyle,
  section: { fontSize: 20, fontWeight: "700" } satisfies TextStyle,
  subtitle: { fontSize: 16, fontWeight: "400" } satisfies TextStyle,
  body: { fontSize: 15, fontWeight: "400" } satisfies TextStyle,
  caption: { fontSize: 13, fontWeight: "400" } satisfies TextStyle,
  hint: { fontSize: 12, fontWeight: "400" } satisfies TextStyle,
  badge: { fontSize: 11, fontWeight: "600" } satisfies TextStyle,
  button: { fontSize: 16, fontWeight: "700" } satisfies TextStyle,
} as const;

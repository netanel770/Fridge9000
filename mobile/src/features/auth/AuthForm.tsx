import * as Google from "expo-auth-session/providers/google";
import * as WebBrowser from "expo-web-browser";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { AppButton, Card, ScreenHeader } from "../../components/ui";
import { GOOGLE_OAUTH_CLIENT_IDS } from "../../services/config";
import { colors, radius, spacing, typography } from "../../theme";
import { useAuth } from "./AuthContext";

WebBrowser.maybeCompleteAuthSession();

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const googleConfigured = Boolean(GOOGLE_OAUTH_CLIENT_IDS.web || GOOGLE_OAUTH_CLIENT_IDS.ios || GOOGLE_OAUTH_CLIENT_IDS.android);

  async function submit() {
    setBusy(true); setError("");
    try {
      if (mode === "login") await auth.signIn(email.trim(), password);
      else await auth.register(email.trim(), password, displayName);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed.");
    } finally { setBusy(false); }
  }

  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <ScreenHeader eyebrow="Fridge9000" title={mode === "login" ? "Welcome back" : "Create your account"} subtitle={mode === "login" ? "Sign in to open your fridge." : "Register with your email and choose a secure password."} />
      <Card><View style={styles.form}>
        {mode === "register" ? <Field label="Display name (optional)" value={displayName} onChange={setDisplayName} autoCapitalize="words" /> : null}
        <Field label="Email" value={email} onChange={setEmail} autoCapitalize="none" keyboardType="email-address" />
        <Field label="Password" value={password} onChange={setPassword} autoCapitalize="none" secure />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <AppButton label={mode === "login" ? "Sign in" : "Create account"} loading={busy} onPress={() => { void submit(); }} />
      </View></Card>
      {googleConfigured ? <GoogleSignIn disabled={busy} onError={setError} onBusy={setBusy} /> : <Text style={styles.googleHint}>Google sign-in becomes available after OAuth client IDs are configured.</Text>}
      <Pressable onPress={() => router.replace((mode === "login" ? "/register" : "/login") as never)}><Text style={styles.switchText}>{mode === "login" ? "New here? Create an account" : "Already registered? Sign in"}</Text></Pressable>
    </ScrollView>
  </KeyboardAvoidingView>;
}

function GoogleSignIn({ disabled, onError, onBusy }: { disabled: boolean; onError: (value: string) => void; onBusy: (value: boolean) => void }) {
  const { signInWithGoogle } = useAuth();
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    clientId: GOOGLE_OAUTH_CLIENT_IDS.web || GOOGLE_OAUTH_CLIENT_IDS.ios || GOOGLE_OAUTH_CLIENT_IDS.android || "not-configured",
    webClientId: GOOGLE_OAUTH_CLIENT_IDS.web,
    iosClientId: GOOGLE_OAUTH_CLIENT_IDS.ios,
    androidClientId: GOOGLE_OAUTH_CLIENT_IDS.android,
  });
  useEffect(() => {
    if (response?.type !== "success") return;
    const idToken = response.params.id_token;
    if (!idToken) { onError("Google did not return an ID token."); return; }
    onBusy(true); onError("");
    signInWithGoogle(idToken).catch((caught) => onError(caught instanceof Error ? caught.message : "Google sign-in failed.")).finally(() => onBusy(false));
  }, [onBusy, onError, response, signInWithGoogle]);
  return <AppButton label="Continue with Google" icon="logo-google" variant="secondary" disabled={disabled || !request} onPress={() => { void promptAsync(); }} />;
}

function Field({ label, value, onChange, autoCapitalize, keyboardType, secure = false }: { label: string; value: string; onChange: (value: string) => void; autoCapitalize: "none" | "words"; keyboardType?: "email-address"; secure?: boolean }) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChange} autoCapitalize={autoCapitalize} autoCorrect={false} keyboardType={keyboardType} secureTextEntry={secure} style={styles.input} /></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, container: { flexGrow: 1, justifyContent: "center", padding: spacing.xl, gap: spacing.lg },
  form: { gap: spacing.md }, field: { gap: spacing.xs }, label: { color: colors.textSecondary, fontWeight: "700" }, input: { minHeight: 50, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, paddingHorizontal: spacing.md, backgroundColor: colors.surface, color: colors.textPrimary },
  error: { color: colors.danger, backgroundColor: colors.dangerBg, borderRadius: radius.md, padding: spacing.sm, fontWeight: "600" }, switchText: { ...typography.body, color: colors.primary, textAlign: "center", fontWeight: "800" }, googleHint: { color: colors.textMuted, textAlign: "center", fontSize: 12 },
});

import { router, usePathname } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { colors } from "../../theme";
import { useAuth } from "../auth/AuthContext";
import { useHousehold } from "../households/HouseholdContext";

const AUTH_ROUTES = new Set(["/login", "/register"]);
const NO_HOUSEHOLD_ADMIN_ROUTES = new Set(["/account", "/household-onboarding", "/teach-fridge", "/system-admins"]);

export function AppGate({ children }: { children: ReactNode }) {
  const path = usePathname();
  const auth = useAuth();
  const household = useHousehold();

  useEffect(() => {
    if (!auth.ready || (auth.user && !household.ready)) return;
    if (!auth.user && !AUTH_ROUTES.has(path)) router.replace("/login" as never);
    else if (auth.user && AUTH_ROUTES.has(path)) router.replace((household.selected ? "/" : "/account") as never);
    else if (auth.user && !household.selected && path !== "/account" && path !== "/household-onboarding" && !(auth.user.is_system_admin && NO_HOUSEHOLD_ADMIN_ROUTES.has(path))) router.replace("/account" as never);
    else if (auth.user && household.selected && (path === "/account" || path === "/household-onboarding")) router.replace("/");
  }, [auth.ready, auth.user, household.ready, household.selected, path]);

  const redirecting = !auth.ready || (Boolean(auth.user) && !household.ready)
    || (!auth.user && !AUTH_ROUTES.has(path))
    || (Boolean(auth.user) && AUTH_ROUTES.has(path))
    || (Boolean(auth.user) && !household.selected && path !== "/account" && path !== "/household-onboarding" && !(auth.user?.is_system_admin && NO_HOUSEHOLD_ADMIN_ROUTES.has(path)));
  if (redirecting) return <View style={styles.loading}><ActivityIndicator size="large" color={colors.primary} /></View>;
  return children;
}

const styles = StyleSheet.create({ loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background } });

import { ScrollView, StyleSheet } from "react-native";
import { HouseholdOnboarding } from "../src/features/households/HouseholdOnboarding";
import { colors, spacing } from "../src/theme";
export default function HouseholdOnboardingScreen() { return <ScrollView style={styles.screen} contentContainerStyle={styles.container}><HouseholdOnboarding /></ScrollView>; }
const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.background }, container: { padding: spacing.xl, paddingBottom: 44 } });

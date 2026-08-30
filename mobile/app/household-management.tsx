import { ScrollView, StyleSheet } from "react-native";
import { HouseholdManagement } from "../src/features/household-management/HouseholdManagement";
import { colors, spacing } from "../src/theme";
export default function HouseholdManagementScreen() { return <ScrollView style={styles.screen} contentContainerStyle={styles.container}><HouseholdManagement /></ScrollView>; }
const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.background }, container: { padding: spacing.xl, paddingBottom: 44 } });

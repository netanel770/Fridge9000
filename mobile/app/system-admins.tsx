import { ScrollView, StyleSheet } from "react-native";
import { SystemAdminManagement } from "../src/features/system-admins/SystemAdminManagement";
import { colors, spacing } from "../src/theme";
export default function SystemAdminsScreen() { return <ScrollView style={styles.screen} contentContainerStyle={styles.container}><SystemAdminManagement /></ScrollView>; }
const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.background }, container: { padding: spacing.xl, paddingBottom: 44 } });

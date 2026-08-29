import { Pressable, ScrollView, Text } from "react-native";

import type { RecentScan } from "../../../../types/api";
import { styles } from "../../styles";

export function ScanSelector({ scans, selectedScan, onSelect }: {
  scans: RecentScan[];
  selectedScan: RecentScan | null;
  onSelect: (scan: RecentScan) => void;
}) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scanList}>
    {scans.map((scan) => {
      const selected = selectedScan?.id === scan.id;
      return <Pressable key={scan.id} accessibilityRole="button" onPress={() => onSelect(scan)} style={[styles.scanChip, selected && styles.selectedScanChip]}>
        <Text style={[styles.scanChipTitle, selected && styles.selectedScanText]}>Scan #{scan.id}</Text>
        <Text style={[styles.scanChipMeta, selected && styles.selectedScanText]}>{new Date(scan.created_at).toLocaleDateString("en-GB")}</Text>
        <Text style={[styles.scanChipMeta, selected && styles.selectedScanText]}>{scan.detection_count} detection{Number(scan.detection_count) === 1 ? "" : "s"}</Text>
      </Pressable>;
    })}
  </ScrollView>;
}

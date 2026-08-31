import { Text, View } from "react-native";

import { AppButton, Card } from "../../../../components/ui";
import { styles } from "../../styles";

export function ContributionsMenu({
  onHistory,
  onReviewQueue,
}: {
  onHistory: () => void;
  onReviewQueue: () => void;
}) {
  return (
    <View style={styles.suggestions}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>Contributions</Text>
      </View>
      <Card>
        <AppButton label="Contribution History" icon="time-outline" onPress={onHistory} />
      </Card>
      <Card>
        <AppButton label="Review Queue" icon="shield-checkmark-outline" onPress={onReviewQueue} />
      </Card>
    </View>
  );
}

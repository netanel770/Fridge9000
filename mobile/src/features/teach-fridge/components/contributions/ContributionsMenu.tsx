import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";

import { AppButton, Card } from "../../../../components/ui";
import { styles } from "../../styles";

export function ContributionsMenu({
  history,
  reviewQueue,
}: {
  history: ReactNode;
  reviewQueue?: ReactNode;
}) {
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [reviewQueueExpanded, setReviewQueueExpanded] = useState(false);

  return (
    <View style={styles.suggestions}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>Contributions</Text>
      </View>
      <Card>
        <AppButton
          label="Contribution History"
          icon={historyExpanded ? "chevron-up" : "chevron-down"}
          onPress={() => setHistoryExpanded((expanded) => !expanded)}
        />
      </Card>
      {historyExpanded ? history : null}
      {reviewQueue !== undefined ? (
        <>
          <Card>
            <AppButton
              label="Review Queue"
              icon={reviewQueueExpanded ? "chevron-up" : "chevron-down"}
              onPress={() => setReviewQueueExpanded((expanded) => !expanded)}
            />
          </Card>
          {reviewQueueExpanded ? reviewQueue : null}
        </>
      ) : null}
    </View>
  );
}

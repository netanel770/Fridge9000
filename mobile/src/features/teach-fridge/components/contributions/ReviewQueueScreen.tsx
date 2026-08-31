import { View } from "react-native";

import type { ModerationState } from "../../hooks/useModeration";
import { styles } from "../../styles";
import { ModerationQueue } from "./ModerationQueue";

export function ReviewQueueScreen({ moderation }: { moderation: ModerationState }) {
  return (
    <View style={styles.suggestions}>
      <ModerationQueue
        submissions={moderation.submissions}
        loading={moderation.loading}
        error={moderation.error}
        message={moderation.message}
        moderatingSubmissionId={moderation.moderatingSubmissionId}
        expandedAnnotationIds={moderation.expandedAnnotationIds}
        onReload={moderation.loadModeration}
        onModerate={moderation.moderateSubmission}
        onToggleDetails={moderation.toggleAnnotationDetails}
      />
    </View>
  );
}

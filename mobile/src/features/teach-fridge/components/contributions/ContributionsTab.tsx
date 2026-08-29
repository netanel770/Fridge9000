import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppButton, Card, EmptyState } from "../../../../components/ui";
import { colors } from "../../../../theme";
import type { ContributionFilter, ContributionSort, Contribution } from "../../types";
import type { ModerationState } from "../../hooks/useModeration";
import { styles } from "../../styles";
import { ContributionCard } from "./ContributionCard";
import { ContributionFilters } from "./ContributionFilters";
import { ModerationQueue } from "./ModerationQueue";

export function ContributionsTab({ contributions, productLabelSuggestions, contributionMessage, displayNameForModel, onViewImage, onEditLabel, onEditBox, moderation }: {
  contributions: {
    loading: boolean; error: string; filter: ContributionFilter; setFilter: (value: ContributionFilter) => void; search: string; setSearch: (value: string) => void;
    labelFilter: string; setLabelFilter: (value: string) => void; sort: ContributionSort; setSort: (value: ContributionSort) => void;
    visibleContributions: Contribution[]; groups: { label: string; contributions: Contribution[] }[]; hasFilters: boolean; clearFilters: () => void; loadContributions: () => void;
  };
  productLabelSuggestions: string[];
  contributionMessage: string;
  displayNameForModel: (model: { version?: string | null }) => string;
  onViewImage: (contribution: Contribution) => void;
  onEditLabel: (contribution: Contribution) => void;
  onEditBox: (contribution: Contribution) => void;
  moderation: ModerationState;
}) {
  return <View style={styles.suggestions}>
    <View style={styles.sectionHeading}><View><Text style={styles.sectionTitle}>Contribution history</Text><Text style={styles.sectionSubtitle}>See what the AI predicted, what you changed, and what happened next.</Text></View><Pressable accessibilityRole="button" onPress={contributions.loadContributions} hitSlop={8}><Ionicons name="refresh" size={21} color={colors.primary} /></Pressable></View>
    <ContributionFilters filter={contributions.filter} search={contributions.search} labelFilter={contributions.labelFilter} sort={contributions.sort} suggestions={productLabelSuggestions} hasFilters={contributions.hasFilters} onFilter={contributions.setFilter} onSearch={contributions.setSearch} onLabelFilter={contributions.setLabelFilter} onSort={contributions.setSort} onClear={contributions.clearFilters} />
    {contributionMessage ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={20} color={colors.successFg} /><Text style={styles.successText}>{contributionMessage}</Text></View> : null}
    {contributions.loading ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>Loading contributions...</Text></View> : null}
    {contributions.error ? <View style={styles.errorBox}><Text style={styles.errorText}>{contributions.error}</Text><AppButton label="Try Again" variant="secondary" onPress={contributions.loadContributions} /></View> : null}
    {!contributions.loading && !contributions.error && contributions.visibleContributions.length === 0 ? <Card><EmptyState icon="search-outline" title={contributions.search.trim() ? `No labels match “${contributions.search.trim()}”` : contributions.labelFilter.trim() ? `No ${contributions.labelFilter.trim()} contributions` : "No contributions found"} message={contributions.filter === "All" ? "Try another product label or clear the current filters." : `There are no ${contributions.filter.toLowerCase()} contributions matching these filters.`} action={contributions.hasFilters ? "Clear filters" : undefined} onAction={contributions.hasFilters ? contributions.clearFilters : undefined} /></Card> : null}
    {!contributions.loading && contributions.groups.map((group) => <View key={group.label || "all-contributions"} style={styles.contributionGroup}>{contributions.sort === "Product" ? <View style={styles.groupHeading}><Text style={styles.groupTitle}>{group.label}</Text><Text style={styles.groupCount}>{group.contributions.length} contribution{group.contributions.length === 1 ? "" : "s"}</Text></View> : null}{group.contributions.map((contribution) => <View key={contribution.annotation.id}><ContributionCard contribution={contribution} displayNameForModel={displayNameForModel} onViewImage={() => onViewImage(contribution)} onEditLabel={() => onEditLabel(contribution)} onEditBox={() => onEditBox(contribution)} /></View>)}</View>)}
    <ModerationQueue submissions={moderation.submissions} loading={moderation.loading} error={moderation.error} message={moderation.message} moderatingSubmissionId={moderation.moderatingSubmissionId} expandedAnnotationIds={moderation.expandedAnnotationIds} onReload={moderation.loadModeration} onModerate={moderation.moderateSubmission} onToggleDetails={moderation.toggleAnnotationDetails} />
  </View>;
}

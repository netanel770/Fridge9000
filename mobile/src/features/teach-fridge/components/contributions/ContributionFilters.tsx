import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { AppButton, Card } from "../../../../components/ui";
import { ProductLabelInput } from "../../../../components/ProductLabelInput";
import { colors } from "../../../../theme";
import {
  CONTRIBUTION_FILTERS,
  type ContributionFilter,
  type ContributionSort,
} from "../../types";
import { styles } from "../../styles";

export function ContributionFilters({
  filter,
  search,
  labelFilter,
  sort,
  suggestions,
  allowUserSort,
  hasFilters,
  onFilter,
  onSearch,
  onLabelFilter,
  onSort,
  onClear,
}: {
  filter: ContributionFilter;
  search: string;
  labelFilter: string;
  sort: ContributionSort;
  suggestions: string[];
  allowUserSort: boolean;
  hasFilters: boolean;
  onFilter: (filter: ContributionFilter) => void;
  onSearch: (value: string) => void;
  onLabelFilter: (value: string) => void;
  onSort: (sort: ContributionSort) => void;
  onClear: () => void;
}) {
  const sortOptions: ContributionSort[] = allowUserSort
    ? ["Newest", "Oldest", "Product", "User"]
    : ["Newest", "Oldest", "Product"];

  return (
    <Card>
      <TextInput
        value={search}
        onChangeText={onSearch}
        placeholder="Search by product label"
        placeholderTextColor={colors.textMuted}
        accessibilityLabel="Search contributions by product label"
        autoCapitalize="words"
        returnKeyType="search"
        style={styles.searchInput}
      />
      <ProductLabelInput
        value={labelFilter}
        onChangeText={onLabelFilter}
        suggestions={suggestions}
        placeholder="Filter by exact product"
        accessibilityLabel="Filter contributions by exact product label"
      />

      <View>
        <Text style={styles.filterCaption}>STATUS</Text>
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterList}
        >
          {CONTRIBUTION_FILTERS.map((item) => {
            const selected = filter === item;
            return (
              <Pressable
                key={item}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Show ${item.toLowerCase()} contributions`}
                onPress={() => onFilter(item)}
                style={[
                  styles.filterChip,
                  selected && styles.selectedFilterChip,
                ]}
              >
                <Text
                  style={[
                    styles.filterText,
                    selected && styles.selectedFilterText,
                  ]}
                >
                  {item}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {filter === "All" ? (
          <Text style={styles.detectionMeta}>
            Contributions already used for training are hidden. Select Used to
            open training history.
          </Text>
        ) : null}
      </View>

      <View>
        <Text style={styles.filterCaption}>SORT</Text>
        <View style={styles.sortOptions}>
          {sortOptions.map((item) => {
            const selected = sort === item;
            return (
              <Pressable
                key={item}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Sort contributions by ${item.toLowerCase()}`}
                onPress={() => onSort(item)}
                style={[
                  styles.filterChip,
                  styles.sortChip,
                  selected && styles.selectedFilterChip,
                ]}
              >
                <Text
                  style={[
                    styles.filterText,
                    selected && styles.selectedFilterText,
                  ]}
                >
                  {item}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {hasFilters ? (
        <AppButton
          label="Clear filters"
          icon="close-circle-outline"
          variant="ghost"
          onPress={onClear}
        />
      ) : null}
    </Card>
  );
}

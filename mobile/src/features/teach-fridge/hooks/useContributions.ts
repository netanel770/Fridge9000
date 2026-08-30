import { useCallback, useEffect, useRef, useState } from "react";

import { getAnnotationSubmission, getAnnotationSubmissions, getMyAnnotationSubmission, getMyAnnotationSubmissions } from "../../../services/api";
import { filterAndSortContributions, groupContributions, trainingState } from "../contributionUtils";
import type { Contribution, ContributionFilter, ContributionSort } from "../types";

export function useContributions(active: boolean, scope: "admin" | "mine" = "admin") {
  const [filter, setFilter] = useState<ContributionFilter>("All");
  const [search, setSearch] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [sort, setSort] = useState<ContributionSort>("Newest");
  const [contributions, setContributions] = useState<Contribution[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);

  const loadContributions = useCallback(async () => {
    const requestId = ++request.current;
    setLoading(true);
    setError("");
    try {
      const submissions = scope === "mine" ? await getMyAnnotationSubmissions() : await getAnnotationSubmissions();
      const details = await Promise.all(submissions.map((submission) => scope === "mine" ? getMyAnnotationSubmission(submission.id) : getAnnotationSubmission(submission.id)));
      if (request.current === requestId) {
        setContributions(details
          .filter((detail) => trainingState(detail.submission) !== "quarantined")
          .flatMap((detail) => detail.annotations.map((annotation) => ({ submission: detail.submission, annotation }))));
      }
    } catch (caught) {
      if (request.current === requestId) {
        setContributions([]);
        setError(caught instanceof Error ? caught.message : "Could not load contributions.");
      }
    } finally {
      if (request.current === requestId) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    if (active) void loadContributions();
  }, [active, loadContributions]);

  const visibleContributions = filterAndSortContributions(contributions, filter, search, labelFilter, sort);
  const groups = groupContributions(visibleContributions, sort);
  const hasFilters = filter !== "All" || Boolean(search.trim()) || Boolean(labelFilter.trim()) || sort !== "Newest";
  const clearFilters = useCallback(() => {
    setSearch("");
    setLabelFilter("");
    setFilter("All");
    setSort("Newest");
  }, []);

  return {
    contributions,
    loading,
    error,
    filter,
    setFilter,
    search,
    setSearch,
    labelFilter,
    setLabelFilter,
    sort,
    setSort,
    visibleContributions,
    groups,
    hasFilters,
    clearFilters,
    loadContributions,
  };
}

import { useCallback, useEffect, useState } from "react";
import { getHouseholdMembers, manageHouseholdMember } from "../../services/api";
import type { HouseholdMembersResponse } from "../../types/api";

export function useHouseholdMembers(fridgeId: number | undefined) {
  const [data, setData] = useState<HouseholdMembersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actingUserId, setActingUserId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!fridgeId) return;
    setLoading(true); setError("");
    try { setData(await getHouseholdMembers(fridgeId)); }
    catch (caught) { setData(null); setError(caught instanceof Error ? caught.message : "Could not load household members."); }
    finally { setLoading(false); }
  }, [fridgeId]);
  useEffect(() => { void load(); }, [load]);
  const act = useCallback(async (userId: number, action: "approve" | "reject" | "remove") => {
    if (!fridgeId) return;
    setActingUserId(userId); setError("");
    try { await manageHouseholdMember(fridgeId, userId, action); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : `Could not ${action} this membership.`); }
    finally { setActingUserId(null); }
  }, [fridgeId, load]);
  return { data, loading, actingUserId, error, load, act };
}

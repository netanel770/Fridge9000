import { useCallback, useEffect, useState } from "react";
import { getUserModelOverview } from "../../services/api";
import type { UserModelOverview } from "../../types/api";

export function useUserModelOverview(active: boolean) {
  const [data, setData] = useState<UserModelOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await getUserModelOverview()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load model information."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (active) void load(); }, [active, load]);
  return { data, loading, error, load };
}

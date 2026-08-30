import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  getMyHouseholds,
  setSelectedHouseholdHeader,
} from "../../services/api";
import {
  getStoredValue,
  setStoredValue,
} from "../../services/storage";
import type { HouseholdMembership } from "../../types/api";
import { useAuth } from "../auth/AuthContext";

const SELECTED_HOUSEHOLD_KEY =
  "fridge9000.selected-household";

type HouseholdContextValue = {
  ready: boolean;
  memberships: HouseholdMembership[];
  activeMemberships: HouseholdMembership[];
  pendingMemberships: HouseholdMembership[];
  selected: HouseholdMembership | null;
  householdEpoch: number;
  refresh: (
    preferredFridgeId?: number,
  ) => Promise<void>;
  selectHousehold: (
    fridgeId: number,
  ) => Promise<void>;
};

const HouseholdContext =
  createContext<HouseholdContextValue | null>(null);

function parseStoredHouseholdId(
  value: string | null,
): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function HouseholdProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuth();

  const [ready, setReady] = useState(false);
  const [memberships, setMemberships] = useState<
    HouseholdMembership[]
  >([]);
  const [selectedId, setSelectedId] = useState<
    number | null
  >(null);
  const [householdEpoch, setHouseholdEpoch] =
    useState(0);

  const load = useCallback(
    async (preferredFridgeId?: number) => {
      if (!user) {
        setMemberships([]);
        setSelectedId(null);
        setSelectedHouseholdHeader(null);
        setReady(true);

        return;
      }

      setReady(false);

      try {
        const next = await getMyHouseholds();

        const active = next.filter(
          (item) => item.status === "ACTIVE",
        );

        const storedValue = await getStoredValue(
          SELECTED_HOUSEHOLD_KEY,
        );

        const storedId =
          parseStoredHouseholdId(storedValue);

        const desiredId =
          preferredFridgeId ?? storedId;

        const preferred =
          active.find(
            (item) =>
              item.fridge_id === desiredId,
          ) ??
          (active.length === 1
            ? active[0]
            : null);

        setMemberships(next);

        setSelectedId(
          preferred?.fridge_id ?? null,
        );

        setSelectedHouseholdHeader(
          preferred?.fridge_id ?? null,
        );

        if (preferred) {
          await setStoredValue(
            SELECTED_HOUSEHOLD_KEY,
            String(preferred.fridge_id),
          );
        }
      } finally {
        setReady(true);
      }
    },
    [user],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const selectHousehold = useCallback(
    async (fridgeId: number) => {
      const membership = memberships.find(
        (item) =>
          item.fridge_id === fridgeId &&
          item.status === "ACTIVE",
      );

      if (!membership) {
        throw new Error(
          "Select an active household membership.",
        );
      }

      setSelectedId(fridgeId);
      setSelectedHouseholdHeader(fridgeId);

      setHouseholdEpoch(
        (value) => value + 1,
      );

      await setStoredValue(
        SELECTED_HOUSEHOLD_KEY,
        String(fridgeId),
      );
    },
    [memberships],
  );

  const activeMemberships =
    memberships.filter(
      (item) => item.status === "ACTIVE",
    );

  const pendingMemberships =
    memberships.filter(
      (item) => item.status === "PENDING",
    );

  const selected =
    activeMemberships.find(
      (item) => item.fridge_id === selectedId,
    ) ?? null;

  const value =
    useMemo<HouseholdContextValue>(
      () => ({
        ready,
        memberships,
        activeMemberships,
        pendingMemberships,
        selected,
        householdEpoch,
        refresh: load,
        selectHousehold,
      }),
      [
        activeMemberships,
        householdEpoch,
        load,
        memberships,
        pendingMemberships,
        ready,
        selectHousehold,
        selected,
      ],
    );

  return (
    <HouseholdContext.Provider value={value}>
      {children}
    </HouseholdContext.Provider>
  );
}

export function useHousehold() {
  const value = useContext(HouseholdContext);

  if (!value) {
    throw new Error(
      "useHousehold must be used within HouseholdProvider",
    );
  }

  return value;
}

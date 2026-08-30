import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

import { HouseholdProvider, useHousehold } from "../../src/features/households/HouseholdContext";
import { useAuth } from "../../src/features/auth/AuthContext";
import { getMyHouseholds, setSelectedHouseholdHeader } from "../../src/services/api";
import { getStoredValue, setStoredValue } from "../../src/services/storage";
import type { HouseholdMembership, PublicUser } from "../../src/types/api";

jest.mock("../../src/features/auth/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../../src/services/api", () => ({
  getMyHouseholds: jest.fn(),
  setSelectedHouseholdHeader: jest.fn(),
}));
jest.mock("../../src/services/storage", () => ({
  getStoredValue: jest.fn(),
  setStoredValue: jest.fn(),
}));

const user: PublicUser = {
  id: 2, email: "member@example.com", display_name: "Member", is_active: true,
  is_system_admin: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

const memberships: HouseholdMembership[] = [
  { fridge_id: 1, fridge_name: "Home", role: "OWNER", status: "ACTIVE" },
  { fridge_id: 2, fridge_name: "Office", role: "MEMBER", status: "ACTIVE" },
  { fridge_id: 3, fridge_name: "Waiting", role: "MEMBER", status: "PENDING" },
  { fridge_id: 4, fridge_name: "Rejected", role: "MEMBER", status: "REJECTED" },
];

function Probe() {
  const household = useHousehold();
  return <>
    <Text testID="ready">{String(household.ready)}</Text>
    <Text testID="selected">{household.selected?.fridge_name || "none"}</Text>
    <Text testID="active">{household.activeMemberships.map((item) => item.fridge_name).join(",")}</Text>
    <Text testID="pending">{household.pendingMemberships.map((item) => item.fridge_name).join(",")}</Text>
    <Text testID="epoch">{household.householdEpoch}</Text>
    <Pressable testID="select-office" onPress={() => void household.selectHousehold(2)} />
    <Pressable testID="refresh" onPress={() => void household.refresh().catch(() => undefined)} />
  </>;
}

const mockedUseAuth = jest.mocked(useAuth);
const mockedGetMyHouseholds = jest.mocked(getMyHouseholds);
const mockedSetHeader = jest.mocked(setSelectedHouseholdHeader);
const mockedGetStoredValue = jest.mocked(getStoredValue);
const mockedSetStoredValue = jest.mocked(setStoredValue);

describe("HouseholdContext", () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({ user } as ReturnType<typeof useAuth>);
    mockedGetStoredValue.mockResolvedValue(null);
    mockedSetStoredValue.mockResolvedValue();
    mockedGetMyHouseholds.mockResolvedValue(memberships);
  });

  test("automatically selects the sole active fridge and excludes unusable memberships", async () => {
    mockedGetMyHouseholds.mockResolvedValue([memberships[0], memberships[2], memberships[3]]);
    await render(<HouseholdProvider><Probe /></HouseholdProvider>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    expect(screen.getByTestId("selected")).toHaveTextContent("Home");
    expect(screen.getByTestId("active")).toHaveTextContent("Home");
    expect(screen.getByTestId("pending")).toHaveTextContent("Waiting");
    expect(mockedSetHeader).toHaveBeenLastCalledWith(1);
    expect(mockedSetStoredValue).toHaveBeenCalledWith("fridge9000.selected-household", "1");
  });

  test("requires explicit choice with multiple fridges and propagates a switch", async () => {
    await render(<HouseholdProvider><Probe /></HouseholdProvider>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    expect(screen.getByTestId("selected")).toHaveTextContent("none");
    await fireEvent.press(screen.getByTestId("select-office"));
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent("Office"));
    expect(screen.getByTestId("epoch")).toHaveTextContent("1");
    expect(mockedSetHeader).toHaveBeenLastCalledWith(2);
    expect(mockedSetStoredValue).toHaveBeenLastCalledWith("fridge9000.selected-household", "2");
  });

  test("restores only a stored active fridge", async () => {
    mockedGetStoredValue.mockResolvedValue("2");
    await render(<HouseholdProvider><Probe /></HouseholdProvider>);
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent("Office"));
    expect(mockedSetHeader).toHaveBeenLastCalledWith(2);
  });

  test("logout clears stale membership and selected-household API state", async () => {
    mockedGetMyHouseholds.mockResolvedValue([memberships[0]]);
    const view = await render(<HouseholdProvider><Probe /></HouseholdProvider>);
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent("Home"));
    mockedUseAuth.mockReturnValue({ user: null } as ReturnType<typeof useAuth>);
    await view.rerender(<HouseholdProvider><Probe /></HouseholdProvider>);
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent("none"));
    expect(screen.getByTestId("active")).toHaveTextContent("");
    expect(mockedSetHeader).toHaveBeenLastCalledWith(null);
  });

  test("a refresh failure finishes loading without corrupting the current selection", async () => {
    mockedGetMyHouseholds.mockResolvedValue([memberships[0]]);
    await render(<HouseholdProvider><Probe /></HouseholdProvider>);
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent("Home"));
    mockedGetMyHouseholds.mockRejectedValueOnce(new Error("offline"));
    await fireEvent.press(screen.getByTestId("refresh"));
    await waitFor(() => expect(mockedGetMyHouseholds).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    expect(screen.getByTestId("selected")).toHaveTextContent("Home");
    expect(mockedSetHeader).toHaveBeenLastCalledWith(1);
  });
});

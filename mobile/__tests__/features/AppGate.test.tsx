import { render, screen, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";

import { AppGate } from "../../src/features/navigation/AppGate";
import { useAuth } from "../../src/features/auth/AuthContext";
import { useHousehold } from "../../src/features/households/HouseholdContext";
import { router, usePathname } from "expo-router";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  usePathname: jest.fn(),
}));
jest.mock("../../src/features/auth/AuthContext", () => ({ useAuth: jest.fn() }));
jest.mock("../../src/features/households/HouseholdContext", () => ({ useHousehold: jest.fn() }));

const mockedPath = jest.mocked(usePathname);
const mockedAuth = jest.mocked(useAuth);
const mockedHousehold = jest.mocked(useHousehold);
const replace = jest.mocked(router.replace);

function setState({
  path = "/inventory",
  authReady = true,
  user = null as null | { is_system_admin: boolean },
  householdReady = true,
  selected = null as null | { fridge_id: number },
} = {}) {
  mockedPath.mockReturnValue(path);
  mockedAuth.mockReturnValue({ ready: authReady, user } as ReturnType<typeof useAuth>);
  mockedHousehold.mockReturnValue({ ready: householdReady, selected } as ReturnType<typeof useHousehold>);
}

describe("AppGate routing decisions", () => {
  test("sends unauthenticated application routes to login", async () => {
    setState();
    await render(<AppGate><Text>private</Text></AppGate>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("private")).toBeNull();
  });

  test("keeps unauthenticated users on an auth route", async () => {
    setState({ path: "/login" });
    await render(<AppGate><Text>login form</Text></AppGate>);
    expect(screen.getByText("login form")).toBeOnTheScreen();
    expect(replace).not.toHaveBeenCalled();
  });

  test("sends an authenticated user without an active fridge to household setup", async () => {
    setState({ user: { is_system_admin: false } });
    await render(<AppGate><Text>private</Text></AppGate>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/account"));
  });

  test("renders the normal app for an authenticated user with an active fridge", async () => {
    setState({ user: { is_system_admin: false }, selected: { fridge_id: 9 } });
    await render(<AppGate><Text>inventory</Text></AppGate>);
    expect(screen.getByText("inventory")).toBeOnTheScreen();
    expect(replace).not.toHaveBeenCalled();
  });

  test("protects system-admin routes from ordinary users without a fridge", async () => {
    setState({ path: "/teach-fridge", user: { is_system_admin: false } });
    await render(<AppGate><Text>admin</Text></AppGate>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/account"));
  });

  test("allows a system admin to reach admin routes without household membership", async () => {
    setState({ path: "/system-admins", user: { is_system_admin: true } });
    await render(<AppGate><Text>admin tools</Text></AppGate>);
    expect(screen.getByText("admin tools")).toBeOnTheScreen();
    expect(replace).not.toHaveBeenCalled();
  });

  test.each([
    { authReady: false, user: null, householdReady: false },
    { authReady: true, user: { is_system_admin: false }, householdReady: false },
  ])("does not redirect prematurely while providers are loading", async (state) => {
    setState(state);
    await render(<AppGate><Text>private</Text></AppGate>);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText("private")).toBeNull();
  });
});

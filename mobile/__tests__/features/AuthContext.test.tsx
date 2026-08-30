import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Text, Pressable } from "react-native";

import { AuthProvider, useAuth } from "../../src/features/auth/AuthContext";
import type { AuthSessionResponse, PublicUser } from "../../src/types/api";
import {
  configureSessionTransport,
  getCurrentUser,
  loginGoogle,
  loginPassword,
  logoutSession,
  refreshSession,
  registerPassword,
} from "../../src/services/api";
import { deleteStoredValue, getStoredValue, setStoredValue } from "../../src/services/storage";

jest.mock("../../src/services/api", () => ({
  configureSessionTransport: jest.fn(),
  getCurrentUser: jest.fn(),
  loginGoogle: jest.fn(),
  loginPassword: jest.fn(),
  logoutSession: jest.fn(),
  notifyApiContextChanged: jest.fn(),
  refreshSession: jest.fn(),
  registerPassword: jest.fn(),
}));

jest.mock("../../src/services/storage", () => ({
  deleteStoredValue: jest.fn(),
  getStoredValue: jest.fn(),
  setStoredValue: jest.fn(),
}));

const user: PublicUser = {
  id: 17,
  email: "owner@example.com",
  display_name: "Owner",
  is_active: true,
  is_system_admin: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function authSession(overrides: Partial<AuthSessionResponse> = {}): AuthSessionResponse {
  return {
    access_token: "access-token",
    refresh_token: "replacement-refresh",
    token_type: "bearer",
    access_token_expires_at: "2030-01-01T00:00:00Z",
    refresh_token_expires_at: "2030-02-01T00:00:00Z",
    user,
    ...overrides,
  };
}

function Probe() {
  const auth = useAuth();
  return <>
    <Text testID="ready">{String(auth.ready)}</Text>
    <Text testID="user">{auth.user?.email || "none"}</Text>
    <Pressable testID="login" onPress={() => void auth.signIn("owner@example.com", "password")} />
    <Pressable testID="register" onPress={() => void auth.register("new@example.com", "password", "New User")} />
    <Pressable testID="google" onPress={() => void auth.signInWithGoogle("google-token")} />
    <Pressable testID="logout" onPress={() => void auth.signOut()} />
  </>;
}

const mockedGetStoredValue = jest.mocked(getStoredValue);
const mockedSetStoredValue = jest.mocked(setStoredValue);
const mockedDeleteStoredValue = jest.mocked(deleteStoredValue);
const mockedRefreshSession = jest.mocked(refreshSession);
const mockedGetCurrentUser = jest.mocked(getCurrentUser);
const mockedLoginPassword = jest.mocked(loginPassword);
const mockedRegisterPassword = jest.mocked(registerPassword);
const mockedLoginGoogle = jest.mocked(loginGoogle);
const mockedLogoutSession = jest.mocked(logoutSession);

describe("AuthContext", () => {
  beforeEach(() => {
    mockedGetStoredValue.mockResolvedValue(null);
    mockedSetStoredValue.mockResolvedValue();
    mockedDeleteStoredValue.mockResolvedValue();
    mockedLogoutSession.mockResolvedValue({ ok: true });
  });

  test("starts loading, then becomes ready with no stored refresh token", async () => {
    let release!: (value: string | null) => void;
    mockedGetStoredValue.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    await render(<AuthProvider><Probe /></AuthProvider>);
    expect(screen.getByTestId("ready")).toHaveTextContent("false");
    release(null);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    expect(screen.getByTestId("user")).toHaveTextContent("none");
    expect(mockedRefreshSession).not.toHaveBeenCalled();
    expect(configureSessionTransport).toHaveBeenCalled();
  });

  test("restores a refresh session, stores its rotation, and resolves the current user", async () => {
    mockedGetStoredValue.mockResolvedValue("stored-refresh");
    mockedRefreshSession.mockResolvedValue(authSession());
    mockedGetCurrentUser.mockResolvedValue({ ...user, display_name: "Fresh Owner" });
    await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    expect(mockedRefreshSession).toHaveBeenCalledWith("stored-refresh");
    expect(mockedSetStoredValue).toHaveBeenCalledWith("fridge9000.refresh-token", "replacement-refresh");
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("owner@example.com"));
  });

  test("clears an invalid stored session and finishes startup", async () => {
    mockedGetStoredValue.mockResolvedValue("expired-refresh");
    mockedRefreshSession.mockRejectedValue(new Error("expired"));
    await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    expect(mockedDeleteStoredValue).toHaveBeenCalledWith("fridge9000.refresh-token");
    expect(screen.getByTestId("user")).toHaveTextContent("none");
  });

  test.each([
    ["login", mockedLoginPassword, ["owner@example.com", "password"]],
    ["register", mockedRegisterPassword, ["new@example.com", "password", "New User"]],
    ["google", mockedLoginGoogle, ["google-token"]],
  ] as const)("updates user and refresh storage after %s", async (testId, request, args) => {
    request.mockReturnValue(Promise.resolve(authSession()) as never);
    await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    await fireEvent.press(screen.getByTestId(testId));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent(user.email));
    expect(request).toHaveBeenCalledWith(...args);
    expect(mockedSetStoredValue).toHaveBeenCalledWith("fridge9000.refresh-token", "replacement-refresh");
  });

  test("logout revokes the stored refresh token and clears local user state", async () => {
    mockedLoginPassword.mockResolvedValue(authSession());
    mockedGetStoredValue
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("stored-refresh");
    await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    await fireEvent.press(screen.getByTestId("login"));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent(user.email));
    await fireEvent.press(screen.getByTestId("logout"));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("none"));
    expect(mockedLogoutSession).toHaveBeenCalledWith("stored-refresh");
    expect(mockedDeleteStoredValue).toHaveBeenCalledWith("fridge9000.refresh-token");
  });

  test("useAuth rejects use outside its provider", async () => {
    const Invalid = () => { useAuth(); return null; };
    await expect(render(<Invalid />)).rejects.toThrow("useAuth must be used within AuthProvider");
  });
});

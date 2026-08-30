import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  configureSessionTransport,
  getCurrentUser,
  loginGoogle,
  loginPassword,
  logoutSession,
  notifyApiContextChanged,
  refreshSession,
  registerPassword,
  type AuthTokenPayload,
} from "../../services/api";
import {
  deleteStoredValue,
  getStoredValue,
  setStoredValue,
} from "../../services/storage";
import type {
  AuthSessionResponse,
  PublicUser,
} from "../../types/api";

const REFRESH_TOKEN_KEY = "fridge9000.refresh-token";

type AuthContextValue = {
  ready: boolean;
  user: PublicUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    displayName?: string,
  ) => Promise<void>;
  signInWithGoogle: (idToken: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<PublicUser | null>(null);

  const accessTokenRef = useRef<string | null>(null);

  const clearLocalSession = useCallback(async () => {
    accessTokenRef.current = null;
    setUser(null);

    await deleteStoredValue(REFRESH_TOKEN_KEY);

    notifyApiContextChanged();
  }, []);

  const acceptSession = useCallback(
    async (session: AuthTokenPayload | AuthSessionResponse) => {
      await setStoredValue(
        REFRESH_TOKEN_KEY,
        session.refresh_token,
      );

      accessTokenRef.current = session.access_token;
      setUser(session.user as PublicUser);

      notifyApiContextChanged();
    },
    [],
  );

  useEffect(() => {
    configureSessionTransport({
      getAccessToken: () => accessTokenRef.current,
      getRefreshToken: () =>
        getStoredValue(REFRESH_TOKEN_KEY),
      acceptSession,
      clearSession: clearLocalSession,
    });
  }, [acceptSession, clearLocalSession]);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const stored = await getStoredValue(
          REFRESH_TOKEN_KEY,
        );

        if (!stored) {
          return;
        }

        const session = await refreshSession(stored);

        if (!active) {
          return;
        }

        await acceptSession(session);

        const current = await getCurrentUser();

        if (active) {
          setUser(current);
        }
      } catch {
        if (active) {
          await clearLocalSession();
        }
      } finally {
        if (active) {
          setReady(true);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [acceptSession, clearLocalSession]);

  const authenticate = useCallback(
    async (request: Promise<AuthSessionResponse>) => {
      const session = await request;
      await acceptSession(session);
    },
    [acceptSession],
  );

  const signOut = useCallback(async () => {
    const refreshToken = await getStoredValue(
      REFRESH_TOKEN_KEY,
    );

    try {
      if (refreshToken) {
        await logoutSession(refreshToken);
      }
    } finally {
      await clearLocalSession();
    }
  }, [clearLocalSession]);

  const signIn = useCallback(
    (email: string, password: string) =>
      authenticate(loginPassword(email, password)),
    [authenticate],
  );

  const register = useCallback(
    (
      email: string,
      password: string,
      displayName?: string,
    ) =>
      authenticate(
        registerPassword(
          email,
          password,
          displayName,
        ),
      ),
    [authenticate],
  );

  const signInWithGoogle = useCallback(
    (idToken: string) =>
      authenticate(loginGoogle(idToken)),
    [authenticate],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      user,
      signIn,
      register,
      signInWithGoogle,
      signOut,
    }),
    [
      ready,
      register,
      signIn,
      signInWithGoogle,
      signOut,
      user,
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error(
      "useAuth must be used within AuthProvider",
    );
  }

  return value;
}

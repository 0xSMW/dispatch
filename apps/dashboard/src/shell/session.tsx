import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, apiBase, makeClient, publicClient, type Client } from "../lib/client";

export type SessionUser = {
  id?: string;
  email: string;
  name?: string;
  role?: string;
  /** The role's permissions: "full" changes anything, "read" only reads. */
  permissions?: string[];
};

export type Session = {
  apiUrl: string;
  token: string;
  id?: string;
  user?: SessionUser;
};

export type SignIn = {
  apiUrl: string;
  email: string;
  password: string;
};

type SessionValue = {
  session: Session | null;
  client: Client | null;
  signIn: (input: SignIn) => Promise<Session>;
  signOut: () => void;
};

/** sessionStorage key. The token never goes to localStorage. */
export const sessionKey = "dispatch.session";

const SessionContext = createContext<SessionValue | null>(null);

function load(): Session | null {
  try {
    // Older builds kept the API key in localStorage. Drop it.
    localStorage.removeItem("dispatch.apiUrl");
    localStorage.removeItem("dispatch.apiKey");
  } catch {
    // storage blocked
  }
  try {
    const raw = sessionStorage.getItem(sessionKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed.token && parsed.apiUrl ? parsed : null;
  } catch {
    return null;
  }
}

function save(session: Session | null) {
  try {
    if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
    else sessionStorage.removeItem(sessionKey);
  } catch {
    // storage blocked: the session lasts until reload
  }
}

type SessionResponse = {
  id?: string;
  token?: string;
  session?: { id?: string; token?: string };
  user?: SessionUser | null;
};

/**
 * Trades an email and password for a `sess_` token through `POST /sessions`. The password is
 * used once and never stored.
 */
export async function exchange({ apiUrl, email, password }: SignIn): Promise<Session> {
  const base = apiBase(apiUrl);
  const result = await publicClient(base).post<SessionResponse>("/sessions", { email, password });
  const token = result.token ?? result.session?.token;
  if (!token) throw new ApiError("application_error", 500, "The API returned no session token");
  return {
    apiUrl: base,
    token,
    id: result.session?.id ?? result.id,
    user: result.user ?? { email },
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(load);

  const clear = useCallback(() => {
    save(null);
    setSession(null);
  }, []);

  const client = useMemo(
    () => (session ? makeClient({ apiUrl: session.apiUrl, token: session.token, onUnauthorized: clear }) : null),
    [session, clear],
  );

  // A session stored by an older build has no permissions, and may have no ID to sign out with.
  // Read both once from GET /me.
  const stale = Boolean(session && (!session.user?.permissions || !session.id));
  useEffect(() => {
    if (!stale || !client) return;
    client
      .get<{ user?: SessionUser | null; session_id?: string | null }>("/me")
      .then(({ user, session_id: id }) => {
        if (!user) return;
        setSession((current) => {
          if (!current) return current;
          const next = { ...current, user, id: current.id ?? id ?? undefined };
          save(next);
          return next;
        });
      })
      .catch(() => undefined);
  }, [stale, client]);

  const signIn = useCallback(async (input: SignIn) => {
    const next = await exchange(input);
    save(next);
    setSession(next);
    return next;
  }, []);

  const signOut = useCallback(() => {
    if (client && session?.id) client.delete(`/sessions/${session.id}`).catch(() => undefined);
    clear();
  }, [client, session, clear]);

  const value = useMemo(() => ({ session, client, signIn, signOut }), [session, client, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession needs a SessionProvider");
  return value;
}

/**
 * Whether the signed-in user can change things. A viewer's role has "read" and not "full", so
 * pages hide their create, edit, delete, and send actions. The API refuses those calls anyway.
 * A session with no permissions yet (an older build's, until GET /me answers) can only read, so
 * a failed lookup never shows actions the user may not have. A role changed while signed in
 * shows in the buttons after the next sign-in. The API applies it at once.
 */
export function useCan(): boolean {
  const permissions = useContext(SessionContext)?.session?.user?.permissions;
  return Boolean(permissions?.includes("full"));
}

/** The signed-in API client. Only call it below `Shell`, which guarantees a session. */
export function useClient(): Client {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useClient needs a SessionProvider");
  if (!value.client) throw new Error("useClient needs a signed-in session");
  return value.client;
}

import { useEffect, useState, useCallback } from 'react';

import { GuestSessionContext } from './guestSessionContext.js';

const STORAGE_KEY = 'snaporder_guest_session';

function readStoredSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // A session past its own expiry is treated the same as no session —
    // GUEST_SESSION_EXPIRY (auth.js) already bounds this server-side;
    // this just avoids handing a token we already know is dead to an
    // API call that would just reject it.
    if (!parsed.expiresAt || new Date(parsed.expiresAt).getTime() <= Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    // Corrupted/foreign localStorage value — treat as no session rather
    // than throwing on every render.
    return null;
  }
}

export function GuestSessionProvider({ children }) {
  const [session, setSessionState] = useState(readStoredSession);

  useEffect(() => {
    try {
      if (session) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Private browsing / storage disabled — the session still works
      // for this tab via React state, it just won't survive a refresh.
    }
  }, [session]);

  const setSession = useCallback((next) => setSessionState(next), []);
  const clearSession = useCallback(() => setSessionState(null), []);

  return (
    <GuestSessionContext.Provider value={{ session, setSession, clearSession }}>
      {children}
    </GuestSessionContext.Provider>
  );
}

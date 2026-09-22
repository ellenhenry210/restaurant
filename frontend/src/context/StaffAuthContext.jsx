import { useEffect, useState, useCallback } from 'react';

import { StaffAuthContext } from './staffAuthContext.js';

export const STAFF_SESSION_STORAGE_KEY = 'snaporder_staff_session';

// Same persisted-in-localStorage pattern as GuestSessionContext.jsx —
// survives a refresh, private-browsing/storage-disabled degrades to
// React-state-only for the tab rather than throwing.
function readStoredSession() {
  try {
    const raw = localStorage.getItem(STAFF_SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function StaffAuthProvider({ children }) {
  const [session, setSessionState] = useState(readStoredSession);

  useEffect(() => {
    try {
      if (session) {
        localStorage.setItem(STAFF_SESSION_STORAGE_KEY, JSON.stringify(session));
      } else {
        localStorage.removeItem(STAFF_SESSION_STORAGE_KEY);
      }
    } catch {
      // Private browsing / storage disabled — session still works for
      // this tab via React state, it just won't survive a refresh.
    }
  }, [session]);

  const setSession = useCallback((next) => setSessionState(next), []);
  const clearSession = useCallback(() => setSessionState(null), []);

  return <StaffAuthContext.Provider value={{ session, setSession, clearSession }}>{children}</StaffAuthContext.Provider>;
}

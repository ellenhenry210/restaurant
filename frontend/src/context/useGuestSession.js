import { useContext } from 'react';

import { GuestSessionContext } from './guestSessionContext.js';

export function useGuestSession() {
  const ctx = useContext(GuestSessionContext);
  if (!ctx) {
    throw new Error('useGuestSession must be used within a GuestSessionProvider');
  }
  return ctx;
}

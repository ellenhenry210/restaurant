import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';

import { useGuestSession } from '../context/useGuestSession';
import { apiClient } from '../api/client';
import { getCurrentPosition } from '../api/geolocation';

// The proximity check at scan time (ScanPage.jsx) only proves where the
// guest was at that one moment — nothing re-checked it afterwards, so a
// guest could scan while present, then leave, and keep full access for
// the rest of the session's 4-hour token. This interval closes that gap
// by periodically re-proving location for as long as a guarded page is
// mounted; the backend (POST /guest/session/heartbeat) is the actual
// authority and revokes the session server-side the moment it's out of
// range, this is just what triggers the check on a schedule.
const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;

// Guards /menu, /cart, /checkout — none of them make sense without an
// active, proximity-verified guest session (there's no restaurant/table
// context to browse a menu for, or place an order against). Sent back
// to "/" rather than shown an error: the fix is "scan the QR code
// again," not something to explain on this page.
export default function RequireGuestSession() {
  const { session, clearSession } = useGuestSession();

  useEffect(() => {
    if (!session) return undefined;

    let cancelled = false;

    async function checkIn() {
      try {
        const { latitude, longitude } = await getCurrentPosition();
        if (cancelled) return;
        await apiClient.post(
          '/guest/session/heartbeat',
          { latitude, longitude },
          { headers: { Authorization: `Bearer ${session.token}` } }
        );
      } catch (err) {
        if (cancelled) return;
        // Only a confirmed rejection from the backend (out of range, or
        // the session no longer exists/expired) ends the session. A
        // geolocation failure or network hiccup is left alone — it just
        // retries on the next tick, rather than kicking the guest out
        // for a transient GPS/connectivity blip.
        const status = err?.response?.status;
        if (status === 401 || status === 403) {
          clearSession();
        }
      }
    }

    const intervalId = setInterval(checkIn, HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [session, clearSession]);

  if (!session) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}

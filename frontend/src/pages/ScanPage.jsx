import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';

import { apiClient } from '../api/client';
import { getCurrentPosition } from '../api/geolocation';
import { useGuestSession } from '../context/useGuestSession';
import { applyRestaurantTheme } from '../theme';
import Spinner from '../components/Spinner';

const STAGE = {
  MISSING_CODE: 'missing_code',
  LOCATING: 'locating',
  SCANNING: 'scanning',
  LOADING_PROFILE: 'loading_profile',
  SUCCESS: 'success',
  ERROR: 'error',
};

const STAGE_MESSAGE = {
  [STAGE.LOCATING]: "Getting your location — you'll be asked to allow this.",
  [STAGE.SCANNING]: "Confirming you're at the restaurant…",
  [STAGE.LOADING_PROFILE]: 'Loading your table…',
};

// The QR code a table's physical sign encodes (backend/src/controllers/
// qrController.js) links here: GUEST_APP_BASE_URL + "/scan?code=" +
// tables.qr_code_unique_id — an opaque token, not a guessable table
// number, so this page's own job is just: extract that token, get the
// guest's location, exchange both for a proximity-verified session
// (POST /v1/tables/:qrCodeId/scan), then load enough of that session to
// show the guest they're in the right place, and send them on to
// pages/MenuPage.jsx.
export default function ScanPage() {
  const [searchParams] = useSearchParams();
  const code = searchParams.get('code');
  const navigate = useNavigate();
  const { setSession } = useGuestSession();

  const [stage, setStage] = useState(code ? STAGE.LOCATING : STAGE.MISSING_CODE);
  const [errorMessage, setErrorMessage] = useState(null);
  const [profile, setProfile] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!code) return undefined;

    let cancelled = false;

    async function run() {
      try {
        setErrorMessage(null);
        setStage(STAGE.LOCATING);
        const { latitude, longitude } = await getCurrentPosition();
        if (cancelled) return;

        setStage(STAGE.SCANNING);
        const scanRes = await apiClient.post(`/tables/${code}/scan`, { latitude, longitude });
        if (cancelled) return;
        const { session_token: token, expires_at: expiresAt, restaurant } = scanRes.data;

        setStage(STAGE.LOADING_PROFILE);
        const [sessionRes, restaurantRes] = await Promise.all([
          apiClient.get('/guest/session', { headers: { Authorization: `Bearer ${token}` } }),
          apiClient.get(`/restaurants/${restaurant.id}`),
        ]);
        if (cancelled) return;

        applyRestaurantTheme(restaurantRes.data);

        const guestSession = {
          token,
          expiresAt,
          restaurantId: restaurant.id,
          tableId: sessionRes.data.session.table_id,
          restaurantName: sessionRes.data.restaurant_name,
          tableNumber: sessionRes.data.table_number,
          server: sessionRes.data.server,
        };
        setSession(guestSession);
        setProfile(guestSession);
        setStage(STAGE.SUCCESS);
      } catch (err) {
        if (cancelled) return;
        const apiMessage = err?.response?.data?.error?.message;
        setErrorMessage(apiMessage || err.message || 'Something went wrong — please try again.');
        setStage(STAGE.ERROR);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // `code` intentionally the only real dependency — `attempt` exists
    // purely to let the Try Again button re-trigger this same effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, attempt]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-md py-2xl text-center">
      <div className="w-full max-w-sm">
        {stage === STAGE.MISSING_CODE && (
          <InfoCard tone="danger" icon="🚫" title="Invalid QR code">
            This doesn&apos;t look like a valid table code. Please scan the QR code on your table to get started.
          </InfoCard>
        )}

        {(stage === STAGE.LOCATING || stage === STAGE.SCANNING || stage === STAGE.LOADING_PROFILE) && (
          <div className="flex flex-col items-center gap-md">
            <Spinner />
            <p className="text-sm text-ink-secondary">{STAGE_MESSAGE[stage]}</p>
          </div>
        )}

        {stage === STAGE.ERROR && (
          <div className="flex flex-col gap-md">
            <InfoCard tone="danger" icon="🚨" title="Couldn't confirm your table">
              {errorMessage}
            </InfoCard>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="btn-secondary">
              Try Again
            </button>
          </div>
        )}

        {stage === STAGE.SUCCESS && profile && (
          <div className="flex flex-col gap-md rounded-lg bg-white p-lg shadow-sm">
            <span className="text-3xl" aria-hidden="true">
              ✅
            </span>
            <h1 className="text-[24px] font-semibold leading-[1.33] tracking-[-0.25px] text-ink">
              You&apos;re in! Welcome to {profile.restaurantName}
            </h1>
            <p className="font-mono text-[14px] font-semibold text-ink">Table {profile.tableNumber}</p>
            {profile.server && (
              <p className="text-sm text-ink-secondary">
                You&apos;re being served by <span className="font-medium text-ink">{profile.server.name}</span>
              </p>
            )}
            <button type="button" className="btn-primary mt-sm" onClick={() => navigate('/menu')}>
              View Menu
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

function InfoCard({ tone, icon, title, children }) {
  const toneClasses = tone === 'danger' ? 'border-danger bg-danger-light text-[#7F1D1D]' : 'border-brand bg-brand-light text-[#065F46]';
  return (
    <div className={`rounded-lg border-l-4 p-md text-left ${toneClasses}`}>
      <p className="text-xs font-semibold">
        {icon} {title}
      </p>
      <p className="mt-1 text-[13px]">{children}</p>
    </div>
  );
}


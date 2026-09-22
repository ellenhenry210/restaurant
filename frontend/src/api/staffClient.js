import axios from 'axios';

import { STAFF_SESSION_STORAGE_KEY } from '../context/StaffAuthContext.jsx';

// A separate axios instance from api/client.js (the guest one) — guest
// pages already set Authorization per-call explicitly, so a shared
// instance's interceptors would either duplicate that or interfere with
// it. Staff pages instead read the token from here automatically, so
// every staff API call doesn't need to thread the token through by hand.
export const staffApiClient = axios.create({
  baseURL: `${import.meta.env.VITE_API_BASE_URL}/v1`,
});

staffApiClient.interceptors.request.use((config) => {
  try {
    const raw = localStorage.getItem(STAFF_SESSION_STORAGE_KEY);
    const session = raw ? JSON.parse(raw) : null;
    if (session?.access_token) {
      config.headers.Authorization = `Bearer ${session.access_token}`;
    }
  } catch {
    // Corrupted storage — proceed without a token; the request will 401
    // and the response interceptor below handles that uniformly.
  }
  return config;
});

// Deliberately NOT a silent refresh-on-401 (that needs the interceptor
// and the React context to share one source of truth, which is more
// machinery than a first version needs — access tokens last a full
// shift, per JWT_EXPIRY). A 401 here just ends the session outright and
// sends the user back to log in again, the same "session died, please
// re-authenticate" UX the guest side already has for an expired guest
// session.
staffApiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      try {
        localStorage.removeItem(STAFF_SESSION_STORAGE_KEY);
      } catch {
        // Nothing more we can do — the request will still reject below,
        // which is enough to keep the caller from acting on stale data.
      }
      if (!window.location.pathname.startsWith('/staff/login')) {
        window.location.href = '/staff/login';
      }
    }
    return Promise.reject(error);
  }
);

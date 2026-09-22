import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { staffApiClient } from '../../api/staffClient';
import { useStaffAuth } from '../../context/useStaffAuth';

// Two-step form: email+password, then (only if the account has MFA
// enabled) a TOTP code against the challenge_token /login just handed
// back — mirrors backend/src/routes/auth.js's login -> mfa/verify-login
// flow exactly; this page has no logic of its own beyond following it.
export default function LoginPage() {
  const { setSession } = useStaffAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeToken, setChallengeToken] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function finishLogin(session) {
    setSession(session);
    navigate('/staff', { replace: true });
  }

  async function handlePasswordSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await staffApiClient.post('/auth/login', { email, password });
      if (res.data.mfa_required) {
        setChallengeToken(res.data.challenge_token);
      } else {
        finishLogin(res.data);
      }
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Could not log in — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCodeSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await staffApiClient.post('/auth/mfa/verify-login', { challenge_token: challengeToken, code });
      finishLogin(res.data);
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Invalid code — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-md py-2xl">
      <div className="w-full max-w-sm rounded-lg bg-white p-lg shadow-sm">
        <h1 className="text-[24px] font-semibold leading-[1.25] tracking-[-0.5px] text-ink">SnapOrder Staff</h1>

        {!challengeToken ? (
          <form onSubmit={handlePasswordSubmit} className="mt-lg flex flex-col gap-md">
            <Field label="Email">
              <input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Field label="Password">
              <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            {error && <p className="text-xs text-danger">{error}</p>}
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Logging in…' : 'Log in'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleCodeSubmit} className="mt-lg flex flex-col gap-md">
            <p className="text-sm text-ink-secondary">Enter the 6-digit code from your authenticator app.</p>
            <Field label="Verification code">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                className="input font-mono tracking-widest"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
              />
            </Field>
            {error && <p className="text-xs text-danger">{error}</p>}
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Verifying…' : 'Verify'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-secondary">{label}</span>
      {children}
    </label>
  );
}

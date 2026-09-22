import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiClient } from '../api/client';
import { useGuestSession } from '../context/useGuestSession';
import { formatMoney } from '../utils/money';

const TIMING_OPTIONS = [
  { value: 'pay_now', label: 'Pay Now', description: 'Pay straight away' },
  { value: 'pay_after', label: 'Pay After', description: "Pay when you're ready to leave" },
  { value: 'pay_traditional', label: 'Pay Traditionally', description: 'Call a member of staff to pay in person' },
];

// The table-level billing system (sittings -> bills -> splits) was
// fully built and tested backend-first — this is the first screen that
// renders any of it. Covers the whole spec: three payment timings, and
// (for pay_now/pay_after) an explicit split-the-bill choice that's
// never the default.
export default function BillPage() {
  const { session } = useGuestSession();
  const navigate = useNavigate();

  // No loading state: there's no "get my current bill" endpoint without
  // already knowing its id (POST /guest/session/bill is the only
  // lookup, and it's idempotent — a second call just returns the
  // existing bill rather than creating another), so a first visit has
  // nothing to fetch on mount at all. The timing picker below is shown
  // until the guest picks one, at which point that same idempotent POST
  // either creates the bill or hands back one that already existed.
  const [bill, setBill] = useState(null);
  const [split, setSplit] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const authHeader = { headers: { Authorization: `Bearer ${session.token}` } };

  const refreshSplit = useCallback(
    async (billId) => {
      try {
        const res = await apiClient.get(`/bills/${billId}/splits`, authHeader);
        setSplit(res.data);
      } catch {
        setSplit(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.token]
  );

  // Shared by "pay the whole bill" and "pay this share" — same flow
  // (initialize against Paystack, then redirect to its checkout page),
  // just a different endpoint. window.location.assign() rather than
  // assigning window.location.href directly — a plain navigation, not a
  // mutation of a captured object, which is what actually matters here.
  async function startPayment(initializeUrl) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const res = await apiClient.post(initializeUrl, { callback_url: window.location.href }, authHeader);
      window.location.assign(res.data.authorization_url);
    } catch (err) {
      setErrorMessage(err?.response?.data?.error?.message || 'Could not start payment.');
      setBusy(false);
    }
  }

  async function chooseTiming(timing) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const res = await apiClient.post('/guest/session/bill', { timing }, authHeader);
      setBill(res.data);
      // The POST is idempotent — a revisit after already having
      // requested a split returns that same existing bill, already
      // split_requested. Pick up the share breakdown in that case too.
      if (res.data.status === 'split_requested') {
        await refreshSplit(res.data.id);
      }
    } catch (err) {
      setErrorMessage(err?.response?.data?.error?.message || 'There are no orders to bill yet — place an order first.');
    } finally {
      setBusy(false);
    }
  }

  function payWhole() {
    return startPayment(`/bills/${bill.id}/payments/initialize`);
  }

  async function requestEvenSplit(numParties) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const res = await apiClient.post(`/bills/${bill.id}/request-split`, { split_type: 'even', num_parties: numParties }, authHeader);
      setSplit(res.data);
      setBill((prev) => ({ ...prev, status: 'split_requested' }));
    } catch (err) {
      setErrorMessage(err?.response?.data?.error?.message || 'Could not split the bill.');
    } finally {
      setBusy(false);
    }
  }

  function paySharePart(shareId) {
    return startPayment(`/bills/splits/${shareId}/payments/initialize`);
  }

  return (
    <main className="flex flex-1 flex-col px-md py-md pb-2xl">
      <h1 className="text-[24px] font-semibold leading-[1.25] tracking-[-0.5px] text-ink">Your Bill</h1>

      {errorMessage && <div className="mt-md rounded-md border-l-4 border-danger bg-danger-light p-md text-[13px] text-[#991B1B]">{errorMessage}</div>}

      {!bill && (
        <div className="mt-lg flex flex-col gap-sm">
          <p className="text-sm text-ink-secondary">How would you like to pay?</p>
          {TIMING_OPTIONS.map((opt) => (
            <button key={opt.value} type="button" disabled={busy} onClick={() => chooseTiming(opt.value)} className="rounded-lg bg-white p-md text-left shadow-sm">
              <p className="text-sm font-semibold text-ink">{opt.label}</p>
              <p className="text-xs text-ink-secondary">{opt.description}</p>
            </button>
          ))}
        </div>
      )}

      {bill && (
        <div className="mt-lg flex flex-col gap-md">
          <div className="rounded-lg bg-white p-md shadow-sm">
            <div className="flex justify-between text-sm">
              <span className="text-ink-secondary">Subtotal</span>
              <span className="font-mono text-ink">{formatMoney(bill.subtotal, bill.currency)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-ink-secondary">Tax</span>
              <span className="font-mono text-ink">{formatMoney(bill.tax, bill.currency)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-ink-secondary">Service charge</span>
              <span className="font-mono text-ink">{formatMoney(bill.service_charge, bill.currency)}</span>
            </div>
            <div className="mt-sm flex justify-between border-t border-border pt-sm text-sm font-semibold">
              <span className="text-ink">Total</span>
              <span className="font-mono text-ink">{formatMoney(bill.total_amount, bill.currency)}</span>
            </div>
          </div>

          {bill.status === 'paid' || bill.status === 'settled_traditionally' ? (
            <div className="rounded-md border-l-4 border-brand bg-brand-light p-md text-[13px] text-[#047857]">✅ Bill settled — thank you!</div>
          ) : bill.timing === 'pay_traditional' ? (
            <div className="rounded-md border-l-4 border-warn bg-warn-light p-md text-[13px] text-[#92400E]">
              A member of staff has been called to collect payment.
            </div>
          ) : split ? (
            <div className="flex flex-col gap-sm">
              <p className="text-sm font-medium text-ink">Split {split.shares.length} ways</p>
              {split.shares.map((share) => (
                <div key={share.id} className="flex items-center justify-between rounded-lg bg-white p-md shadow-sm">
                  <div>
                    <p className="text-sm text-ink">{share.guest_label}</p>
                    <p className="font-mono text-xs text-ink-secondary">{formatMoney(share.amount_owed, bill.currency)}</p>
                  </div>
                  {share.payment_status === 'paid' ? (
                    <span className="text-xs font-semibold text-brand">Paid</span>
                  ) : (
                    <button type="button" className="btn-secondary" disabled={busy} onClick={() => paySharePart(share.id)}>
                      Pay this share
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-sm">
              <button type="button" className="btn-primary" disabled={busy} onClick={payWhole}>
                Pay full amount
              </button>
              <SplitPicker onSplit={requestEvenSplit} disabled={busy} />
            </div>
          )}
        </div>
      )}

      <button type="button" className="btn-secondary mt-lg" onClick={() => navigate(-1)}>
        Back
      </button>
    </main>
  );
}

function SplitPicker({ onSplit, disabled }) {
  const [open, setOpen] = useState(false);
  const [parties, setParties] = useState(2);

  if (!open) {
    return (
      <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setOpen(true)}>
        Split the bill
      </button>
    );
  }

  return (
    <div className="flex items-center gap-sm rounded-lg bg-white p-md shadow-sm">
      <label className="flex-1 text-sm text-ink-secondary">
        Split evenly between
        <input
          type="number"
          min="2"
          className="input mt-1 font-mono"
          value={parties}
          onChange={(e) => setParties(Math.max(2, Number(e.target.value)))}
        />
      </label>
      <button type="button" className="btn-primary" disabled={disabled} onClick={() => onSplit(parties)}>
        Split
      </button>
    </div>
  );
}

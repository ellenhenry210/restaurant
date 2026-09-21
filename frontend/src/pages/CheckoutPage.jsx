import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiClient } from '../api/client';
import { useGuestSession } from '../context/useGuestSession';
import { useCart } from '../context/useCart';
import { formatMoney } from '../utils/money';

// Ingredient removal / addon customization (the allergen removal-policy
// engine, SNAPORDER_AUTHORIZATION.md Part 3) is intentionally not
// exposed here — a real, separate piece of UI work not in this slice's
// scope. Every item still goes through POST /v1/orders exactly as the
// backend expects; removed_ingredients/added_addons just stay empty.
export default function CheckoutPage() {
  const { session } = useGuestSession();
  const { cart, subtotal, clear } = useCart();
  const navigate = useNavigate();

  const [phoneNumber, setPhoneNumber] = useState('');
  const [guestName, setGuestName] = useState('');
  const [specialRequests, setSpecialRequests] = useState('');
  const [tipAmount, setTipAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [errorMessage, setErrorMessage] = useState(null);

  const currency = cart.items[0]?.currency ?? 'NGN';

  async function handleSubmit(event) {
    event.preventDefault();
    setErrorMessage(null);
    setFieldErrors({});

    if (!phoneNumber.trim()) {
      setFieldErrors({ phone_number: 'Phone number is required' });
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiClient.post(
        '/orders',
        {
          phone_number: phoneNumber.trim(),
          guest_name: guestName.trim() || undefined,
          items: cart.items.map((item) => ({
            meal_id: item.mealId,
            quantity: item.quantity,
            special_request: item.specialRequest ?? undefined,
          })),
          special_requests: specialRequests.trim() || undefined,
          tip_amount: tipAmount ? Number(tipAmount) : undefined,
        },
        { headers: { Authorization: `Bearer ${session.token}` } }
      );

      clear();
      navigate(`/order/${res.data.id}`);
    } catch (err) {
      const apiError = err?.response?.data?.error;
      if (apiError?.details) {
        setFieldErrors(Object.fromEntries(apiError.details.map((d) => [d.field, d.reason])));
      }
      setErrorMessage(apiError?.message || 'Could not place your order — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col px-md py-md pb-2xl">
      <h1 className="text-[24px] font-semibold leading-[1.25] tracking-[-0.5px] text-ink">Checkout</h1>

      <div className="mt-md rounded-lg bg-white p-md shadow-sm">
        {cart.items.map((item) => (
          <div key={item.mealId} className="flex justify-between py-1 text-sm">
            <span className="text-ink-secondary">
              {item.quantity}× {item.name}
            </span>
            <span className="font-mono text-ink">{formatMoney(item.unitPrice * item.quantity, item.currency)}</span>
          </div>
        ))}
        <div className="mt-sm flex justify-between border-t border-border pt-sm text-sm font-semibold">
          <span className="text-ink">Subtotal</span>
          <span className="font-mono text-ink">{formatMoney(subtotal, currency)}</span>
        </div>
        <p className="mt-1 text-xs text-ink-secondary">Tax and service charge are added when your order is placed.</p>
      </div>

      <form onSubmit={handleSubmit} className="mt-lg flex flex-col gap-md">
        <Field label="Phone number" error={fieldErrors.phone_number}>
          <input
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+234 812 345 6789"
            className="input"
          />
        </Field>

        <Field label="Name (optional)">
          <input type="text" value={guestName} onChange={(e) => setGuestName(e.target.value)} className="input" />
        </Field>

        <Field label="Special requests (optional)">
          <textarea
            value={specialRequests}
            onChange={(e) => setSpecialRequests(e.target.value)}
            className="input"
            rows={3}
            placeholder="Table is allergic to peanuts, please serve quickly, etc."
          />
        </Field>

        <Field label="Add a tip (optional)">
          <input
            type="number"
            min="0"
            step="50"
            value={tipAmount}
            onChange={(e) => setTipAmount(e.target.value)}
            className="input font-mono"
            placeholder="0"
          />
        </Field>

        {errorMessage && (
          <div className="rounded-md border-l-4 border-danger bg-danger-light p-md text-[13px] text-[#991B1B]">{errorMessage}</div>
        )}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Placing your order…' : 'Place Order'}
        </button>
      </form>
    </main>
  );
}

function Field({ label, error, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-secondary">{label}</span>
      {children}
      {error && <span className="text-xs text-danger">{error}</span>}
    </label>
  );
}

import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { io } from 'socket.io-client';

import { apiClient } from '../api/client';
import { useGuestSession } from '../context/useGuestSession';
import { formatMoney } from '../utils/money';
import Spinner from '../components/Spinner';

const ITEM_STATUS_LABEL = {
  pending: 'Pending',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  cancelled: 'Cancelled',
};

// Requires an active guest session (the same token that placed the
// order) — there's no other guest identity mechanism yet (see
// known-gaps.md), so an order can only be checked on from the session
// that placed it, not e.g. via a link shared/reopened after that
// session's own expiry.
export default function OrderStatusPage() {
  const { orderId } = useParams();
  const { session } = useGuestSession();

  const [order, setOrder] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [payState, setPayState] = useState('idle');
  const [payError, setPayError] = useState(null);

  const fetchOrder = useCallback(() => {
    return apiClient
      .get(`/orders/${orderId}`, { headers: { Authorization: `Bearer ${session.token}` } })
      .then((res) => {
        setOrder(res.data);
        setLoadState('ready');
        return res.data;
      });
  }, [orderId, session.token]);

  useEffect(() => {
    fetchOrder().catch(() => setLoadState('error'));
  }, [fetchOrder]);

  // Live status updates — guests are auto-joined to table:{tableId} on
  // socket connect (backend/src/realtime.js); this just filters that
  // table's broadcasts down to the one order this page cares about,
  // rather than polling.
  useEffect(() => {
    const socket = io(import.meta.env.VITE_API_BASE_URL, { auth: { token: session.token } });

    socket.on('order_status_updated', (data) => {
      if (data.order_id !== orderId) return;
      setOrder((prev) => (prev ? { ...prev, status: data.status } : prev));
    });
    socket.on('item_status_updated', (data) => {
      if (data.order_id !== orderId) return;
      setOrder((prev) =>
        prev ? { ...prev, items: prev.items.map((item) => (item.id === data.item_id ? { ...item, status: data.status } : item)) } : prev
      );
    });

    return () => socket.disconnect();
  }, [session.token, orderId]);

  // Returning from Paystack's hosted checkout lands back here (callback_url
  // below) with a ?reference=/?trxref= query param. The webhook that
  // actually confirms payment can land a moment after that redirect, so
  // briefly poll rather than showing a stale "unpaid" state.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('reference') && !params.has('trxref')) return undefined;
    if (order?.payment_status === 'completed') return undefined;

    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      fetchOrder().catch(() => {});
      if (attempts >= 10) clearInterval(interval);
    }, 3000);
    return () => clearInterval(interval);
     
  }, [fetchOrder, order?.payment_status]);

  async function handlePay() {
    setPayState('initializing');
    setPayError(null);
    try {
      const res = await apiClient.post(
        `/orders/${orderId}/payments/initialize`,
        { callback_url: window.location.href },
        { headers: { Authorization: `Bearer ${session.token}` } }
      );
      window.location.href = res.data.authorization_url;
    } catch (err) {
      setPayError(err?.response?.data?.error?.message || 'Could not start payment — please try again.');
      setPayState('error');
    }
  }

  if (loadState === 'loading') {
    return (
      <main className="flex flex-1 items-center justify-center">
        <Spinner />
      </main>
    );
  }
  if (loadState === 'error' || !order) {
    return (
      <main className="flex flex-1 items-center justify-center px-md text-center">
        <p className="text-sm text-danger">Could not load this order.</p>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col px-md py-md pb-2xl">
      <h1 className="text-[24px] font-semibold leading-[1.25] tracking-[-0.5px] text-ink">Order {order.order_number}</h1>
      <StatusBadge status={order.status} />

      <div className="mt-lg rounded-lg bg-white p-md shadow-sm">
        {order.items.map((item) => (
          <div key={item.id} className="flex items-center justify-between border-b border-border py-2 last:border-0">
            <div>
              <p className="text-sm text-ink">
                {item.quantity}× {item.meal_name}
              </p>
              <p className="text-xs text-ink-secondary">{ITEM_STATUS_LABEL[item.status] ?? item.status}</p>
            </div>
            <span className="font-mono text-sm text-ink">{formatMoney(item.meal_price * item.quantity, order.currency)}</span>
          </div>
        ))}

        <div className="mt-md flex flex-col gap-1 text-sm">
          <Row label="Subtotal" value={formatMoney(order.subtotal, order.currency)} />
          <Row label="Tax" value={formatMoney(order.tax, order.currency)} />
          <Row label="Service Charge" value={formatMoney(order.service_charge, order.currency)} />
          {Number(order.tip_amount) > 0 && <Row label="Tip" value={formatMoney(order.tip_amount, order.currency)} />}
          <Row label="Total" value={formatMoney(order.grand_total, order.currency)} bold />
        </div>
      </div>

      {order.server && (
        <p className="mt-md text-sm text-ink-secondary">
          Served by <span className="font-medium text-ink">{order.server.name}</span>
        </p>
      )}

      <div className="mt-lg flex flex-col gap-sm">
        {order.payment_status === 'completed' ? (
          <div className="rounded-md border-l-4 border-brand bg-brand-light p-md text-[13px] text-[#047857]">✅ Payment received</div>
        ) : (
          <>
            <button type="button" className="btn-primary" onClick={handlePay} disabled={payState === 'initializing'}>
              {payState === 'initializing' ? 'Starting payment…' : 'Pay for this order only'}
            </button>
            {payError && <p className="mt-sm text-xs text-danger">{payError}</p>}
          </>
        )}
        {/* The table-level bill (sittings -> bills) — the recommended
            path once more than one order is on the table, or a split is
            wanted: one consolidated bill by default, split only on
            request, plus Pay Now / Pay After / Pay Traditionally. */}
        <Link to="/bill" className="btn-secondary text-center">
          View table bill
        </Link>
      </div>
    </main>
  );
}

function StatusBadge({ status }) {
  const isTerminal = status === 'served' || status === 'cancelled';
  return (
    <span
      className={`mt-sm inline-block w-fit rounded-full px-md py-1 text-xs font-semibold ${
        isTerminal ? 'bg-[#F3F4F6] text-ink-secondary' : 'bg-brand-light text-[#065F46]'
      }`}
    >
      {status}
    </span>
  );
}

function Row({ label, value, bold }) {
  return (
    <div className={`flex justify-between ${bold ? 'font-semibold text-ink' : 'text-ink-secondary'}`}>
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

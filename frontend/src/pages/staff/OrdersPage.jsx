import { useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';

import { staffApiClient } from '../../api/staffClient';
import { useStaffAuth } from '../../context/useStaffAuth';
import { formatMoney } from '../../utils/money';

const VALID_ORDER_TRANSITIONS = {
  placed: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served'],
  served: [],
  cancelled: [],
};

// "Serve guests, mark orders ready" (the staff-app half not covered by
// the item-level Kitchen Display) — order-level status advancement, and
// the Pay-Traditionally "call the waiter" inbox
// (backend/src/realtime.js's staff:{restaurantId} room, built the same
// day as the billing system but never rendered until now).
export default function OrdersPage() {
  const { session } = useStaffAuth();
  const restaurantId = session.user.restaurant_id;

  const [orders, setOrders] = useState([]);
  const [calls, setCalls] = useState([]);
  const [loadState, setLoadState] = useState('loading');

  const upsertOrder = useCallback((partial) => {
    setOrders((prev) => {
      const idx = prev.findIndex((o) => o.id === partial.id);
      if (idx === -1) return prev; // a brand-new order from the socket gets picked up on next refetch — see note below
      const next = [...prev];
      next[idx] = { ...next[idx], ...partial };
      return next.filter((o) => o.status !== 'served' && o.status !== 'cancelled');
    });
  }, []);

  const refetch = useCallback(() => {
    return Promise.all([
      staffApiClient.get(`/restaurants/${restaurantId}/orders`, { params: { status: 'placed,confirmed,preparing,ready' } }),
      staffApiClient.get(`/restaurants/${restaurantId}/staff-calls`, { params: { status: 'pending' } }),
    ]).then(([ordersRes, callsRes]) => {
      setOrders(ordersRes.data.data);
      setCalls(callsRes.data.data);
      setLoadState('ready');
    });
  }, [restaurantId]);

  useEffect(() => {
    refetch().catch(() => setLoadState('error'));
  }, [refetch]);

  useEffect(() => {
    const socket = io(import.meta.env.VITE_API_BASE_URL, { auth: { token: session.access_token } });

    socket.on('connect', () => {
      socket.emit('join_kitchen', { restaurantId }); // view_all_orders room — this page needs new_order/order_status_updated too
      socket.emit('join_staff', { restaurantId });
    });

    // A genuinely new order needs its table_number (not in the socket
    // payload) — simplest correct thing is a full refetch rather than
    // guessing/omitting it.
    socket.on('new_order', () => refetch().catch(() => {}));
    socket.on('order_status_updated', (data) => upsertOrder({ id: data.order_id, status: data.status }));
    socket.on('waiter_called', () => refetch().catch(() => {}));

    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId, refetch, upsertOrder]);

  async function advanceOrder(orderId, nextStatus) {
    try {
      await staffApiClient.patch(`/restaurants/${restaurantId}/orders/${orderId}/status`, { status: nextStatus });
      upsertOrder({ id: orderId, status: nextStatus });
    } catch (err) {
      console.error('Failed to update order status:', err?.response?.data?.error?.message || err.message);
    }
  }

  async function respondToCall(callId, status) {
    try {
      await staffApiClient.patch(`/restaurants/${restaurantId}/staff-calls/${callId}`, { status });
      if (status === 'resolved') {
        setCalls((prev) => prev.filter((c) => c.id !== callId));
      } else {
        setCalls((prev) => prev.map((c) => (c.id === callId ? { ...c, status } : c)));
      }
    } catch (err) {
      console.error('Failed to update staff call:', err?.response?.data?.error?.message || err.message);
    }
  }

  if (loadState === 'loading') {
    return (
      <main className="flex flex-1 items-center justify-center">
        <p className="text-sm text-ink-secondary">Loading…</p>
      </main>
    );
  }
  if (loadState === 'error') {
    return (
      <main className="flex flex-1 items-center justify-center">
        <p className="text-sm text-danger">Could not load orders.</p>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col gap-lg overflow-y-auto p-md md:flex-row">
      <section className="flex-1">
        <h2 className="mb-sm text-[16px] font-semibold text-ink">Active orders</h2>
        <div className="flex flex-col gap-sm">
          {orders.length === 0 && <p className="text-sm text-ink-secondary">No active orders.</p>}
          {orders.map((order) => (
            <div key={order.id} className="flex items-center justify-between rounded-lg bg-white p-md shadow-sm">
              <div>
                <p className="font-mono text-xs text-ink-secondary">{order.order_number}</p>
                <p className="text-sm font-medium text-ink">
                  Table {order.table_number} · <span className="capitalize">{order.status}</span>
                </p>
                <p className="font-mono text-xs text-ink-secondary">{formatMoney(order.total_amount)}</p>
              </div>
              <div className="flex gap-xs">
                {VALID_ORDER_TRANSITIONS[order.status].map((next) => (
                  <button
                    key={next}
                    type="button"
                    onClick={() => advanceOrder(order.id, next)}
                    className={next === 'cancelled' ? 'btn-secondary' : 'btn-primary'}
                  >
                    {next}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="w-full md:w-80">
        <h2 className="mb-sm text-[16px] font-semibold text-ink">Waiter calls</h2>
        <div className="flex flex-col gap-sm">
          {calls.length === 0 && <p className="text-sm text-ink-secondary">No pending calls.</p>}
          {calls.map((call) => (
            <div key={call.id} className="rounded-lg border-l-4 border-warn bg-white p-md shadow-sm">
              <p className="text-sm font-medium text-ink">Table needs the bill</p>
              <p className="text-xs text-ink-secondary">{new Date(call.created_at).toLocaleTimeString()}</p>
              <div className="mt-sm flex gap-xs">
                {call.status === 'pending' && (
                  <button type="button" className="btn-secondary" onClick={() => respondToCall(call.id, 'acknowledged')}>
                    Acknowledge
                  </button>
                )}
                <button type="button" className="btn-primary" onClick={() => respondToCall(call.id, 'resolved')}>
                  Resolved
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

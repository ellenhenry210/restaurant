import { useEffect, useState, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';

import { staffApiClient } from '../../api/staffClient';
import { useStaffAuth } from '../../context/useStaffAuth';

const ITEM_STATUS_COLUMNS = ['pending', 'preparing', 'ready'];
const NEXT_ITEM_STATUS = { pending: 'preparing', preparing: 'ready', ready: 'served' };
const COLUMN_LABEL = { pending: 'New', preparing: 'Preparing', ready: 'Ready' };

// Real-time order queue — backend/socket layer (kitchen:{restaurantId}
// room) has existed since 2026-09-17; this is the first screen that
// actually renders it. Orders/items are hydrated once on load via REST
// (the socket only carries what happens AFTER connecting), then kept in
// sync live via new_order / item_status_updated events.
export default function KitchenDisplayPage() {
  const { session } = useStaffAuth();
  const restaurantId = session.user.restaurant_id;

  const [orders, setOrders] = useState([]);
  const [loadState, setLoadState] = useState('loading');
  const socketRef = useRef(null);

  const upsertOrder = useCallback((order) => {
    setOrders((prev) => {
      const idx = prev.findIndex((o) => o.id === order.id);
      if (idx === -1) return [...prev, order];
      const next = [...prev];
      next[idx] = order;
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const list = await staffApiClient.get(`/restaurants/${restaurantId}/orders`, {
          params: { status: 'placed,confirmed,preparing,ready' },
        });
        const details = await Promise.all(
          list.data.data.map((o) => staffApiClient.get(`/restaurants/${restaurantId}/orders/${o.id}`).then((r) => r.data))
        );
        if (!cancelled) {
          setOrders(details.filter((o) => o.items.some((item) => item.status !== 'served' && item.status !== 'cancelled')));
          setLoadState('ready');
        }
      } catch {
        if (!cancelled) setLoadState('error');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  useEffect(() => {
    const socket = io(import.meta.env.VITE_API_BASE_URL, { auth: { token: session.access_token } });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join_kitchen', { restaurantId }, (ack) => {
        if (!ack?.ok) {
          console.error('join_kitchen failed:', ack?.error);
        }
      });
    });

    socket.on('new_order', (data) => {
      upsertOrder({
        id: data.order_id,
        order_number: data.order_number,
        table_number: data.table_number,
        placed_at: data.placed_at,
        items: data.items.map((item) => ({ id: item.id, meal_name: item.meal_name, quantity: item.quantity, status: 'pending', priority: item.priority })),
      });
    });

    socket.on('item_status_updated', (data) => {
      setOrders((prev) =>
        prev.map((o) =>
          o.id === data.order_id ? { ...o, items: o.items.map((item) => (item.id === data.item_id ? { ...item, status: data.status } : item)) } : o
        )
      );
    });

    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId]);

  async function advanceItem(orderId, itemId, nextStatus) {
    try {
      await staffApiClient.patch(`/restaurants/${restaurantId}/orders/${orderId}/items/${itemId}/status`, { status: nextStatus });
      // The socket event above will also update this, but updating
      // locally too means the button that was just clicked doesn't sit
      // stale for the round-trip.
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, items: o.items.map((item) => (item.id === itemId ? { ...item, status: nextStatus } : item)) } : o))
      );
    } catch (err) {
      console.error('Failed to update item status:', err?.response?.data?.error?.message || err.message);
    }
  }

  if (loadState === 'loading') {
    return (
      <main className="flex flex-1 items-center justify-center">
        <p className="text-sm text-ink-secondary">Loading kitchen queue…</p>
      </main>
    );
  }
  if (loadState === 'error') {
    return (
      <main className="flex flex-1 items-center justify-center">
        <p className="text-sm text-danger">Could not load the kitchen queue.</p>
      </main>
    );
  }

  return (
    <main className="flex flex-1 gap-md overflow-x-auto p-md">
      {ITEM_STATUS_COLUMNS.map((status) => (
        <div key={status} className="flex w-72 shrink-0 flex-col gap-sm">
          <h2 className="text-[14px] font-semibold text-ink-secondary uppercase tracking-wide">{COLUMN_LABEL[status]}</h2>
          {orders.flatMap((order) =>
            order.items
              .filter((item) => item.status === status)
              .map((item) => (
                <div key={item.id} className={`rounded-lg bg-white p-md shadow-sm ${item.priority === 'high' ? 'border-l-4 border-danger' : ''}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-ink-secondary">Table {order.table_number}</span>
                    <span className="font-mono text-xs text-ink-secondary">{order.order_number}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-ink">
                    {item.quantity}× {item.meal_name}
                  </p>
                  {item.special_request && <p className="mt-1 text-xs text-ink-secondary">{item.special_request}</p>}
                  {NEXT_ITEM_STATUS[status] && (
                    <button
                      type="button"
                      onClick={() => advanceItem(order.id, item.id, NEXT_ITEM_STATUS[status])}
                      className="btn-primary mt-sm w-full"
                    >
                      Mark {NEXT_ITEM_STATUS[status]}
                    </button>
                  )}
                </div>
              ))
          )}
        </div>
      ))}
    </main>
  );
}


import { useEffect, useState, useCallback } from 'react';

import { staffApiClient } from '../../api/staffClient';
import { useStaffAuth } from '../../context/useStaffAuth';
import { formatMoney } from '../../utils/money';

const TABS = ['Analytics', 'Menu', 'Inventory', 'Payments'];

// The one screen exposing everything built backend-first this session
// that had no UI at all: revenue/period analytics, the menu editor
// (create + availability toggle), ingredient stock levels, and
// payment history + refunds. Each tab hits real endpoints — nothing
// here is mocked.
export default function AdminDashboardPage() {
  const [tab, setTab] = useState('Analytics');

  return (
    <main className="flex flex-1 flex-col overflow-y-auto p-md">
      <div className="mb-md flex gap-xs overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`shrink-0 rounded-md px-md py-2 text-sm font-medium ${tab === t ? 'bg-brand text-white' : 'bg-white text-ink-secondary'}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'Analytics' && <AnalyticsTab />}
      {tab === 'Menu' && <MenuTab />}
      {tab === 'Inventory' && <InventoryTab />}
      {tab === 'Payments' && <PaymentsTab />}
    </main>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-lg bg-white p-md shadow-sm">
      <p className="text-xs text-ink-secondary">{label}</p>
      <p className="font-mono text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}

function AnalyticsTab() {
  const { session } = useStaffAuth();
  const restaurantId = session.user.restaurant_id;
  const [daily, setDaily] = useState(null);
  const [revenue, setRevenue] = useState(null);
  const [status, setStatus] = useState('loading');

  const load = useCallback(() => {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    return Promise.all([
      staffApiClient.get(`/restaurants/${restaurantId}/analytics/daily`, { params: { date: today, days: 7 } }),
      staffApiClient.get(`/restaurants/${restaurantId}/analytics/revenue`, { params: { period: 'daily', from, to: today } }),
    ]).then(([d, r]) => {
      setDaily(d.data.metrics);
      setRevenue(r.data.breakdown);
      setStatus('ready');
    });
  }, [restaurantId]);

  useEffect(() => {
    load().catch(() => setStatus('error'));
  }, [load]);

  if (status === 'loading') return <p className="text-sm text-ink-secondary">Loading analytics…</p>;
  if (status === 'error') return <p className="text-sm text-danger">Could not load analytics.</p>;

  const maxRevenue = Math.max(1, ...revenue.map((r) => Number(r.revenue)));

  return (
    <div className="flex flex-col gap-lg">
      <div className="grid grid-cols-2 gap-md sm:grid-cols-4">
        <StatCard label="Orders (7d)" value={daily.total_orders} />
        <StatCard label="Revenue (7d)" value={formatMoney(daily.total_revenue)} />
        <StatCard label="Avg order" value={formatMoney(daily.average_order_value)} />
        <StatCard label="Meals sold" value={daily.meals_sold} />
      </div>
      <div>
        <h3 className="mb-sm text-sm font-semibold text-ink">Daily revenue</h3>
        {revenue.length === 0 ? (
          <p className="text-sm text-ink-secondary">No orders in this window yet.</p>
        ) : (
          <div className="flex h-32 items-end gap-xs rounded-lg bg-white p-md shadow-sm">
            {revenue.map((r) => (
              <div key={r.period_start} className="flex flex-1 flex-col items-center gap-1">
                <div className="w-full rounded-t bg-brand" style={{ height: `${Math.max(4, (Number(r.revenue) / maxRevenue) * 96)}px` }} />
                <span className="font-mono text-[10px] text-ink-secondary">
                  {new Date(r.period_start).toLocaleDateString(undefined, { weekday: 'short' })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MenuTab() {
  const { session } = useStaffAuth();
  const restaurantId = session.user.restaurant_id;
  const [menu, setMenu] = useState(null);
  const [status, setStatus] = useState('loading');
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(() => {
    return staffApiClient.get(`/restaurants/${restaurantId}/menus`).then((menus) => {
      const active = menus.data.data[0];
      if (!active) {
        setMenu(null);
        setStatus('ready');
        return undefined;
      }
      return staffApiClient
        .get(`/restaurants/${restaurantId}/menus/${active.id}/meals`, { params: { include_unavailable: 'true' } })
        .then((detail) => {
          setMenu(detail.data);
          setStatus('ready');
        });
    });
  }, [restaurantId]);

  useEffect(() => {
    load().catch(() => setStatus('error'));
  }, [load]);

  async function toggleAvailability(mealId, isAvailable) {
    await staffApiClient.patch(`/restaurants/${restaurantId}/meals/${mealId}/availability`, { is_available: !isAvailable });
    load();
  }

  if (status === 'loading') return <p className="text-sm text-ink-secondary">Loading menu…</p>;
  if (status === 'error') return <p className="text-sm text-danger">Could not load menu.</p>;
  if (!menu) return <p className="text-sm text-ink-secondary">No menu found for this restaurant yet.</p>;

  return (
    <div className="flex flex-col gap-md">
      <button type="button" className="btn-secondary self-start" onClick={() => setShowForm((s) => !s)}>
        {showForm ? 'Cancel' : '+ Add meal'}
      </button>
      {showForm && (
        <CreateMealForm
          restaurantId={restaurantId}
          categories={menu.categories}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}
      {menu.categories.map((cat) => (
        <section key={cat.id}>
          <h3 className="mb-sm text-sm font-semibold text-ink">{cat.name}</h3>
          {cat.meals.length === 0 ? (
            <p className="text-xs text-ink-secondary">No meals in this category yet.</p>
          ) : (
            <div className="flex flex-col gap-sm">
              {cat.meals.map((meal) => (
                <div key={meal.id} className="flex items-center justify-between rounded-lg bg-white p-md shadow-sm">
                  <div>
                    <p className="text-sm font-medium text-ink">{meal.name}</p>
                    <p className="font-mono text-xs text-ink-secondary">{formatMoney(meal.base_price, meal.currency)}</p>
                  </div>
                  <button
                    type="button"
                    className={meal.is_available ? 'btn-secondary' : 'btn-primary'}
                    onClick={() => toggleAvailability(meal.id, meal.is_available)}
                  >
                    {meal.is_available ? 'Mark out of stock' : 'Mark available'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function CreateMealForm({ restaurantId, categories, onCreated }) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [name, setName] = useState('');
  const [basePrice, setBasePrice] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await staffApiClient.post(`/restaurants/${restaurantId}/meals`, {
        category_id: categoryId,
        name,
        base_price: Number(basePrice),
      });
      onCreated();
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Could not create meal.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-sm rounded-lg bg-white p-md shadow-sm">
      <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <input className="input" placeholder="Meal name" value={name} onChange={(e) => setName(e.target.value)} required />
      <input
        className="input font-mono"
        type="number"
        min="0"
        step="0.01"
        placeholder="Price"
        value={basePrice}
        onChange={(e) => setBasePrice(e.target.value)}
        required
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <button type="submit" className="btn-primary" disabled={submitting}>
        {submitting ? 'Adding…' : 'Add meal'}
      </button>
    </form>
  );
}

function InventoryTab() {
  const { session } = useStaffAuth();
  const restaurantId = session.user.restaurant_id;
  const [ingredients, setIngredients] = useState(null);
  const [status, setStatus] = useState('loading');
  const [editing, setEditing] = useState({});

  const load = useCallback(() => {
    return staffApiClient.get(`/restaurants/${restaurantId}/ingredients`).then((res) => {
      setIngredients(res.data.data);
      setStatus('ready');
    });
  }, [restaurantId]);

  useEffect(() => {
    load().catch(() => setStatus('error'));
  }, [load]);

  async function saveStock(ingredientId) {
    const value = editing[ingredientId];
    if (value === undefined || value === '') return;
    await staffApiClient.patch(`/restaurants/${restaurantId}/ingredients/${ingredientId}/stock`, { current_stock: Number(value) });
    setEditing((prev) => ({ ...prev, [ingredientId]: undefined }));
    load();
  }

  if (status === 'loading') return <p className="text-sm text-ink-secondary">Loading ingredients…</p>;
  if (status === 'error') return <p className="text-sm text-danger">Could not load ingredients — you may not have permission (set_inventory_levels/view_inventory is manager+).</p>;
  if (ingredients.length === 0) return <p className="text-sm text-ink-secondary">No ingredients tracked yet.</p>;

  return (
    <div className="flex flex-col gap-sm">
      {ingredients.map((ing) => (
        <div key={ing.id} className="flex items-center justify-between rounded-lg bg-white p-md shadow-sm">
          <div>
            <p className="text-sm font-medium text-ink">{ing.name}</p>
            <p className="font-mono text-xs text-ink-secondary">
              Stock: {ing.current_stock} {ing.unit_of_measure ?? ''}
            </p>
          </div>
          <div className="flex items-center gap-xs">
            <input
              type="number"
              className="input w-24 font-mono"
              placeholder={String(ing.current_stock)}
              value={editing[ing.id] ?? ''}
              onChange={(e) => setEditing((prev) => ({ ...prev, [ing.id]: e.target.value }))}
            />
            <button type="button" className="btn-secondary" onClick={() => saveStock(ing.id)}>
              Save
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function PaymentsTab() {
  const { session } = useStaffAuth();
  const restaurantId = session.user.restaurant_id;
  const [transactions, setTransactions] = useState(null);
  const [status, setStatus] = useState('loading');

  const load = useCallback(() => {
    return staffApiClient.get(`/restaurants/${restaurantId}/payments`).then((res) => {
      setTransactions(res.data.data);
      setStatus('ready');
    });
  }, [restaurantId]);

  useEffect(() => {
    load().catch(() => setStatus('error'));
  }, [load]);

  async function refund(billId) {
    await staffApiClient.post(`/restaurants/${restaurantId}/bills/${billId}/refund`);
    load();
  }

  if (status === 'loading') return <p className="text-sm text-ink-secondary">Loading payments…</p>;
  if (status === 'error') return <p className="text-sm text-danger">Could not load payment history — you may not have permission (view_payment_history is manager+).</p>;
  if (transactions.length === 0) return <p className="text-sm text-ink-secondary">No payments yet.</p>;

  return (
    <div className="flex flex-col gap-sm">
      {transactions.map((txn) => (
        <div key={txn.id} className="flex items-center justify-between rounded-lg bg-white p-md shadow-sm">
          <div>
            <p className="font-mono text-xs text-ink-secondary">{txn.reference}</p>
            <p className="text-sm text-ink">
              {formatMoney(txn.amount, txn.currency)} · <span className="capitalize">{txn.status}</span>
            </p>
            <p className="text-xs text-ink-secondary">{new Date(txn.created_at).toLocaleString()}</p>
          </div>
          {txn.status === 'success' && txn.bill_id && (
            <button type="button" className="btn-secondary" onClick={() => refund(txn.bill_id)}>
              Refund
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

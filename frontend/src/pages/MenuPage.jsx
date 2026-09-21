import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiClient } from '../api/client';
import { useGuestSession } from '../context/useGuestSession';
import { useCart } from '../context/useCart';
import { formatMoney } from '../utils/money';
import Spinner from '../components/Spinner';

export default function MenuPage() {
  const { session } = useGuestSession();
  const { addItem, itemCount, subtotal } = useCart();
  const navigate = useNavigate();

  const [menus, setMenus] = useState([]);
  const [activeMenuId, setActiveMenuId] = useState(null);
  const [menuDetail, setMenuDetail] = useState(null);
  const [status, setStatus] = useState('loading');
  const [errorMessage, setErrorMessage] = useState(null);

  // 1. Which active menus does this restaurant have right now.
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get(`/restaurants/${session.restaurantId}/menus`)
      .then((res) => {
        if (cancelled) return;
        const activeMenus = res.data.data.filter((menu) => menu.is_active);
        if (activeMenus.length === 0) {
          setErrorMessage("This restaurant doesn't have an active menu right now.");
          setStatus('error');
          return;
        }
        setMenus(activeMenus);
        setActiveMenuId(activeMenus[0].id);
      })
      .catch(() => {
        if (cancelled) return;
        setErrorMessage('Could not load the menu — please try again.');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [session.restaurantId]);

  // 2. That menu's categories + meals (re-runs when the guest switches menus).
  useEffect(() => {
    if (!activeMenuId) return undefined;
    let cancelled = false;
    apiClient
      .get(`/restaurants/${session.restaurantId}/menus/${activeMenuId}/meals`)
      .then((res) => {
        if (cancelled) return;
        setMenuDetail(res.data);
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setErrorMessage('Could not load the menu — please try again.');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [activeMenuId, session.restaurantId]);

  if (status === 'error') {
    return (
      <main className="flex flex-1 items-center justify-center px-md text-center">
        <p className="text-sm text-[#7F1D1D]">{errorMessage}</p>
      </main>
    );
  }

  if (status === 'loading' && !menuDetail) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <Spinner />
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col pb-2xl">
      <header className="sticky top-0 z-10 border-b border-border bg-white px-md py-md">
        <h1 className="text-[18px] font-semibold leading-[1.55] text-ink">{session.restaurantName}</h1>
        <p className="font-mono text-[12px] text-ink-secondary">Table {session.tableNumber}</p>
      </header>

      {menus.length > 1 && (
        <div className="flex gap-sm overflow-x-auto px-md py-sm">
          {menus.map((menu) => (
            <button
              key={menu.id}
              type="button"
              onClick={() => {
                setStatus('loading');
                setActiveMenuId(menu.id);
              }}
              className={`whitespace-nowrap rounded-full px-md py-1 text-sm font-medium ${
                menu.id === activeMenuId ? 'bg-brand text-white' : 'bg-white text-ink-secondary'
              }`}
            >
              {menu.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-lg px-md py-md">
        {menuDetail?.categories.map((category) => (
          <section key={category.id}>
            <h2 className="mb-sm text-[18px] font-semibold leading-[1.55] text-ink">{category.name}</h2>
            {category.meals.length === 0 ? (
              <p className="text-sm text-ink-secondary">Nothing available in this category right now.</p>
            ) : (
              <div className="flex flex-col gap-md">
                {category.meals.map((meal) => (
                  <MealCard key={meal.id} meal={meal} onAdd={(quantity) => addItem(session.restaurantId, meal, quantity)} />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      {itemCount > 0 && (
        <button type="button" onClick={() => navigate('/cart')} className="btn-primary fixed inset-x-md bottom-md shadow-lg">
          View Cart · {itemCount} item{itemCount !== 1 ? 's' : ''} · {formatMoney(subtotal)}
        </button>
      )}
    </main>
  );
}

function MealCard({ meal, onAdd }) {
  const [quantity, setQuantity] = useState(1);
  const tags = [
    meal.is_vegan && 'Vegan',
    meal.is_vegetarian && !meal.is_vegan && 'Vegetarian',
    meal.is_gluten_free && 'Gluten-Free',
    meal.is_low_calorie && 'Low Calorie',
    meal.is_high_protein && 'High Protein',
  ].filter(Boolean);

  return (
    <div className="rounded-lg bg-white p-md shadow-sm">
      <div className="flex items-start justify-between gap-md">
        <div className="min-w-0">
          <h3 className="text-[16px] font-semibold text-ink">{meal.name}</h3>
          {meal.description && <p className="mt-1 text-sm text-ink-secondary">{meal.description}</p>}
          {tags.length > 0 && (
            <div className="mt-sm flex flex-wrap gap-xs">
              {tags.map((tag) => (
                <span key={tag} className="rounded-full bg-brand-light px-sm py-1 text-[11px] font-semibold text-[#065F46]">
                  🟢 {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        {meal.image_url && <img src={meal.image_url} alt="" className="h-16 w-16 shrink-0 rounded-md object-cover" />}
      </div>

      <div className="mt-md flex items-center justify-between">
        <span className="font-mono text-[14px] font-semibold text-ink">{formatMoney(meal.base_price, meal.currency)}</span>
        <div className="flex items-center gap-sm">
          <QuantityStepper quantity={quantity} onChange={setQuantity} />
          <button
            type="button"
            onClick={() => {
              onAdd(quantity);
              setQuantity(1);
            }}
            className="rounded-md bg-brand px-md py-2 text-sm font-semibold text-white hover:bg-brand-hover"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function QuantityStepper({ quantity, onChange }) {
  return (
    <div className="flex items-center gap-xs">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, quantity - 1))}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-ink"
        aria-label="Decrease quantity"
      >
        −
      </button>
      <span className="w-4 text-center font-mono text-sm">{quantity}</span>
      <button
        type="button"
        onClick={() => onChange(quantity + 1)}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-ink"
        aria-label="Increase quantity"
      >
        +
      </button>
    </div>
  );
}

import { useNavigate } from 'react-router-dom';

import { useCart } from '../context/useCart';
import { formatMoney } from '../utils/money';

export default function CartPage() {
  const { cart, updateQuantity, removeItem, subtotal } = useCart();
  const navigate = useNavigate();

  if (cart.items.length === 0) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-md px-md text-center">
        <p className="text-sm text-ink-secondary">Your cart is empty.</p>
        <button type="button" className="btn-primary" onClick={() => navigate('/menu')}>
          Browse Menu
        </button>
      </main>
    );
  }

  const currency = cart.items[0]?.currency ?? 'NGN';

  return (
    <main className="flex flex-1 flex-col pb-2xl">
      <header className="border-b border-border px-md py-md">
        <h1 className="text-[24px] font-semibold leading-[1.25] tracking-[-0.5px] text-ink">Your Order</h1>
      </header>

      <div className="flex flex-col gap-md px-md py-md">
        {cart.items.map((item) => (
          <div key={item.mealId} className="flex items-center justify-between gap-md rounded-lg bg-white p-md shadow-sm">
            <div className="min-w-0">
              <p className="text-[16px] font-medium text-ink">{item.name}</p>
              <p className="font-mono text-[14px] text-ink-secondary">{formatMoney(item.unitPrice, item.currency)} each</p>
            </div>
            <div className="flex items-center gap-sm">
              <div className="flex items-center gap-xs">
                <button
                  type="button"
                  onClick={() => updateQuantity(item.mealId, item.quantity - 1)}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-ink"
                  aria-label={`Decrease ${item.name} quantity`}
                >
                  −
                </button>
                <span className="w-4 text-center font-mono text-sm">{item.quantity}</span>
                <button
                  type="button"
                  onClick={() => updateQuantity(item.mealId, item.quantity + 1)}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-ink"
                  aria-label={`Increase ${item.name} quantity`}
                >
                  +
                </button>
              </div>
              <button
                type="button"
                onClick={() => removeItem(item.mealId)}
                className="text-xs font-medium text-danger"
                aria-label={`Remove ${item.name}`}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-sm border-t border-border bg-white px-md py-md">
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-secondary">Subtotal</span>
          <span className="font-mono text-[14px] font-semibold text-ink">{formatMoney(subtotal, currency)}</span>
        </div>
        <p className="text-xs text-ink-secondary">Tax and service charge are calculated at checkout.</p>
        <button type="button" className="btn-primary" onClick={() => navigate('/checkout')}>
          Continue to Checkout
        </button>
      </div>
    </main>
  );
}

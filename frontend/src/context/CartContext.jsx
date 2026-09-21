import { useEffect, useState, useCallback, useMemo } from 'react';

import { CartContext } from './cartContext.js';

const STORAGE_KEY = 'snaporder_cart';

function readStoredCart() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { restaurantId: null, items: [] };
  } catch {
    return { restaurantId: null, items: [] };
  }
}

export function CartProvider({ children }) {
  const [cart, setCart] = useState(readStoredCart);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
    } catch {
      // Private browsing / storage disabled — cart still works for this
      // tab via React state, it just won't survive a refresh.
    }
  }, [cart]);

  // A cart is scoped to one restaurant at a time — adding an item from a
  // different restaurant than what's already in the cart starts a fresh
  // one, rather than mixing two restaurants' orders together (which
  // POST /v1/orders couldn't even represent — an order belongs to
  // exactly one restaurant/table).
  const addItem = useCallback((restaurantId, meal, quantity = 1, specialRequest = null) => {
    setCart((prev) => {
      const base = prev.restaurantId === restaurantId ? prev : { restaurantId, items: [] };
      const existingIndex = base.items.findIndex((item) => item.mealId === meal.id && item.specialRequest === specialRequest);

      if (existingIndex >= 0) {
        const items = [...base.items];
        items[existingIndex] = { ...items[existingIndex], quantity: items[existingIndex].quantity + quantity };
        return { restaurantId, items };
      }

      return {
        restaurantId,
        items: [
          ...base.items,
          {
            mealId: meal.id,
            name: meal.name,
            unitPrice: Number(meal.base_price),
            currency: meal.currency,
            quantity,
            specialRequest,
          },
        ],
      };
    });
  }, []);

  const updateQuantity = useCallback((mealId, quantity) => {
    setCart((prev) => ({
      ...prev,
      items:
        quantity <= 0
          ? prev.items.filter((item) => item.mealId !== mealId)
          : prev.items.map((item) => (item.mealId === mealId ? { ...item, quantity } : item)),
    }));
  }, []);

  const removeItem = useCallback((mealId) => {
    setCart((prev) => ({ ...prev, items: prev.items.filter((item) => item.mealId !== mealId) }));
  }, []);

  const clear = useCallback(() => setCart({ restaurantId: null, items: [] }), []);

  const subtotal = useMemo(() => cart.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0), [cart.items]);
  const itemCount = useMemo(() => cart.items.reduce((sum, item) => sum + item.quantity, 0), [cart.items]);

  const value = useMemo(
    () => ({ cart, addItem, updateQuantity, removeItem, clear, subtotal, itemCount }),
    [cart, addItem, updateQuantity, removeItem, clear, subtotal, itemCount]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

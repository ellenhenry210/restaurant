import { pool } from '../db.js';
import * as orderModel from '../models/orderModel.js';
import { emitNewOrder } from '../realtime.js';

function validateCreateOrderInput(body) {
  const errors = [];
  if (!body.phone_number || typeof body.phone_number !== 'string') {
    errors.push({ field: 'phone_number', reason: 'required' });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push({ field: 'items', reason: 'must be a non-empty array' });
  } else {
    body.items.forEach((item, i) => {
      if (!item.meal_id || typeof item.meal_id !== 'string') {
        errors.push({ field: `items[${i}].meal_id`, reason: 'required' });
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        errors.push({ field: `items[${i}].quantity`, reason: 'must be a positive integer' });
      }
    });
  }
  // Optional — tipping is guest-initiated and entirely at their
  // discretion, so it's simply absent (not 0, not required) unless
  // they choose to include it.
  if (body.tip_amount !== undefined && (typeof body.tip_amount !== 'number' || body.tip_amount < 0)) {
    errors.push({ field: 'tip_amount', reason: 'must be a non-negative number' });
  }
  return errors;
}

// ---------------------------------------------------------------------
// POST /orders — create a new order. Behind authenticateGuest: only a
// guest with a proximity-verified session (see routes/guestSession.js)
// can place one, which is the whole point of that session existing.
//
// This is also the real implementation of the allergen removal-policy
// engine from SNAPORDER_AUTHORIZATION.md Part 3 — see the per-item loop
// below. All the actual queries live in models/orderModel.js; every one
// of them is called with `client` as the executor so the whole flow
// (guest_profile lookup/creation through to inserting the order and its
// items) runs as one transaction — nothing is written unless every item
// validates.
// ---------------------------------------------------------------------
export async function create(req, res) {
  const errors = validateCreateOrderInput(req.body ?? {});
  if (errors.length > 0) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'One or more fields are invalid', details: errors },
    });
  }

  const { phone_number, guest_name, items, special_requests, tip_amount: tipAmount } = req.body;
  const { restaurant_id: restaurantId, table_id: tableId, sitting_id: sittingId } = req.guestSession;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Per-restaurant, not a global constant — a restaurant's tax rate is
    // a fact about that restaurant/jurisdiction, and not everyone
    // charges a service charge at all (migration 008). Fetched once
    // here rather than per-item, since it's the same for the whole order.
    const rates = await orderModel.findRestaurantRates(restaurantId, client);
    const taxRate = rates.tax_rate;
    const serviceChargeRate = rates.service_charge_rate;

    // Find-or-create the guest_profile — this IS "on first order",
    // exactly the trigger point the product design (product-vision)
    // already specified: guest_profiles don't exist until here.
    let guestProfileId = await orderModel.findGuestProfileId(restaurantId, phone_number, client);
    if (!guestProfileId) {
      guestProfileId = await orderModel.createGuestProfile(restaurantId, phone_number, guest_name, client);
    }

    // Link this session to the guest_profile if it isn't already
    // (a returning guest re-scanning gets a fresh session each time,
    // but the same underlying guest_profile via phone_number).
    if (!req.guestSession.guest_profile_id) {
      await orderModel.linkGuestSessionToProfile(req.guestSession.id, guestProfileId, client);
    }

    // Validate and price every item BEFORE inserting anything — a
    // rejected item (unavailable meal, blocked allergen removal, an
    // addon that isn't actually this meal's) fails the whole order, not
    // just that line, so nothing should be written until every item has
    // passed.
    const preparedItems = [];
    let subtotal = 0;

    for (const [i, item] of items.entries()) {
      const meal = await orderModel.findOrderableMeal(item.meal_id, restaurantId, client);
      if (!meal) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: { code: 'INVALID_REQUEST', message: `Item ${i}: meal not found at this restaurant` },
        });
      }
      if (!meal.is_available) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: { code: 'INVALID_REQUEST', message: `Item ${i}: "${meal.name}" is currently unavailable` },
        });
      }

      // --- Allergen removal policy (Part 3) ---
      const removedIngredients = Array.isArray(item.removed_ingredients) ? item.removed_ingredients : [];
      let requiresCautionAck = false;

      if (removedIngredients.length > 0) {
        const policies = await orderModel.findRemovalPolicies(meal.id, removedIngredients, client);
        const policyByIngredient = new Map(policies.map((r) => [r.ingredient_id, r]));

        for (const ingredientId of removedIngredients) {
          const policy = policyByIngredient.get(ingredientId);
          if (!policy) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: { code: 'INVALID_REQUEST', message: `Item ${i}: that ingredient isn't part of "${meal.name}"` },
            });
          }
          if (policy.removal_policy === 'cannot_remove') {
            // Blocked, per policy — not a validation error, a genuine
            // safety refusal. 403, not 400.
            await client.query('ROLLBACK');
            return res.status(403).json({
              error: {
                code: 'FORBIDDEN',
                message: `Item ${i}: cannot remove that ingredient from "${meal.name}"${policy.removal_policy_reason ? ` — ${policy.removal_policy_reason}` : ''}`,
              },
            });
          }
          if (policy.removal_policy === 'caution') {
            requiresCautionAck = true;
          }
        }
      }

      if (requiresCautionAck && item.allergen_caution_acknowledged !== true) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: `Item ${i}: removing this ingredient carries a cross-contamination risk — resubmit with allergen_caution_acknowledged: true to confirm`,
          },
        });
      }

      // --- Addons ---
      const addedAddons = Array.isArray(item.added_addons) ? item.added_addons : [];
      let addonsTotal = 0;

      if (addedAddons.length > 0) {
        const validAddons = await orderModel.findValidAddons(meal.id, addedAddons, client);
        if (validAddons.length !== addedAddons.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: { code: 'INVALID_REQUEST', message: `Item ${i}: one or more addons aren't available for "${meal.name}"` },
          });
        }
        addonsTotal = validAddons.reduce((sum, a) => sum + Number(a.additional_price), 0);
      }

      const unitPrice = Number(meal.base_price) + addonsTotal;
      const lineTotal = unitPrice * item.quantity;
      subtotal += lineTotal;

      preparedItems.push({
        mealId: meal.id,
        mealName: meal.name,
        mealPrice: unitPrice,
        quantity: item.quantity,
        removedIngredients,
        allergenCautionAcknowledged: requiresCautionAck,
        addedAddons,
        specialRequest: item.special_request ?? null,
      });
    }

    // Round to the nearest kobo/cent (2dp) before summing, not after —
    // summing unrounded fractions and rounding once at the end can land
    // a cent off from what tax_rate * subtotal alone would show, which
    // is the kind of "why doesn't this add up" discrepancy a guest
    // would notice on a receipt.
    const tax = Math.round(subtotal * Number(taxRate) * 100) / 100;
    const serviceCharge = Math.round(subtotal * Number(serviceChargeRate) * 100) / 100;
    // total_amount deliberately does NOT include the tip — matches how a
    // receipt normally reads ("Total: X, tip at your discretion"), not
    // folded silently into one number. grand_total (below, in the
    // response only — not its own column) is the actual amount that
    // would be charged/paid, for a client that wants one final figure.
    const totalAmount = subtotal + tax + serviceCharge;
    const tip = tipAmount ?? 0;

    const seq = await orderModel.nextOrderNumberSeq(client);
    const orderNumber = `ORD-${new Date().getFullYear()}-${String(seq).padStart(5, '0')}`;

    const order = await orderModel.insertOrder(
      {
        restaurantId,
        tableId,
        guestProfileId,
        sittingId,
        orderNumber,
        subtotal,
        tax,
        serviceCharge,
        totalAmount,
        tip,
        specialRequests: special_requests ?? null,
      },
      client
    );
    const grandTotal = Number(order.total_amount) + Number(order.tip_amount);

    const insertedItems = [];
    for (const item of preparedItems) {
      const inserted = await orderModel.insertOrderItem({ orderId: order.id, ...item }, client);
      insertedItems.push(inserted);
    }

    const tableNumber = await orderModel.findTableNumber(tableId, client);

    await client.query('COMMIT');

    // Notify the kitchen display in real time. Deliberately its own
    // try/catch, separate from the one below: the order is already
    // successfully committed at this point, so a socket-layer problem
    // (there shouldn't be one in normal operation — realtime.js is
    // always initialized in index.js — but if there ever were) must
    // never turn into a misleading "Failed to create order" response
    // for an order that, in fact, succeeded.
    try {
      emitNewOrder(restaurantId, {
        order_id: order.id,
        order_number: order.order_number,
        table_number: tableNumber,
        // Zipped with preparedItems by index (both built in the same
        // per-item loop, same order) rather than reading
        // allergen_caution_acknowledged off insertedItems — that field
        // isn't in insertOrderItem's RETURNING clause, and adding it
        // there just for this would silently change the shape of the
        // guest-facing order-creation response too, which is a separate
        // decision this KDS work shouldn't make as a side effect.
        items: insertedItems.map((item, i) => ({
          id: item.id,
          meal_name: item.meal_name,
          quantity: item.quantity,
          // Kitchen-relevant signal: this specific item required a
          // guest to acknowledge a cross-contamination risk — worth
          // calling out visually, same idea as the "priority" flag in
          // SNAPORDER_API_CONTRACTS.md's original KDS sketch.
          priority: preparedItems[i].allergenCautionAcknowledged ? 'high' : 'normal',
        })),
        placed_at: order.placed_at,
      });
    } catch (err) {
      console.error('emitNewOrder failed (order was still created successfully):', err.message);
    }

    res.status(201).json({ ...order, grand_total: grandTotal, items: insertedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /orders: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create order' } });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// GET /orders/:id — order status. Ownership check is table-based, not
// guest_profile-based: a guest re-scanning mid-meal gets a NEW
// guest_sessions row (guest_profile_id starts NULL on it again until
// they order in THAT session), so matching on guest_profile would wrongly
// reject them checking an order they placed a few minutes ago in a
// previous session. Matching on table_id instead reflects the actual
// physical reality — you're checking on your order because you're
// sitting at your table, which the current session is scoped to either way.
// ---------------------------------------------------------------------
export async function getStatus(req, res) {
  try {
    const order = await orderModel.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    if (order.table_id !== req.guestSession.table_id || order.restaurant_id !== req.guestSession.restaurant_id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This order does not belong to your table' } });
    }
    order.grand_total = Number(order.total_amount) + Number(order.tip_amount);

    const [items, server] = await Promise.all([
      orderModel.findOrderItems(order.id),
      // Same "who's serving this table" lookup as GET /guest/session —
      // checking on an order is exactly when a guest would want to know.
      orderModel.findAssignedServer(order.table_id),
    ]);

    res.json({
      ...order,
      server: server ? { name: server.display_name ?? server.name, role: server.role } : null,
      items,
    });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    console.error('GET /orders/:id: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load order' } });
  }
}

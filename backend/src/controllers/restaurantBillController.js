import * as billModel from '../models/billModel.js';
import { refundTransaction } from '../paystack.js';
import { logAudit } from '../audit.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------
// POST /restaurants/:restaurantId/bills/:billId/refund — issue_refund
// (manager/owner/system_admin). Only a bill with a successful Paystack
// transaction can be refunded — a pay_traditional bill was never paid
// through Paystack at all, so there's nothing for Paystack to refund
// (reversing cash collected in person is a staff/finance process, not
// something this endpoint can do).
// ---------------------------------------------------------------------
export async function refund(req, res) {
  const { restaurantId, billId } = req.params;

  try {
    const bill = await billModel.findById(billId);
    if (!bill || bill.restaurant_id !== restaurantId) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
    }
    if (bill.status !== 'paid') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: `Only a paid bill can be refunded (status: ${bill.status})` },
      });
    }

    const transaction = await billModel.findSuccessfulTransactionForBill(billId);
    if (!transaction) {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'No successful Paystack transaction found for this bill — it may have been settled in person' },
      });
    }

    await refundTransaction({ reference: transaction.reference, amountKobo: Math.round(Number(transaction.amount) * 100) });

    await billModel.markTransactionRefunded(transaction.id);
    const updated = await billModel.markBillRefunded(billId);

    await logAudit({
      restaurantId,
      action: 'refund_issued',
      actorType: 'staff',
      actorId: req.actor.id,
      resourceType: 'bill',
      resourceId: billId,
      changes: { reference: transaction.reference, amount: transaction.amount },
      ipAddress: req.ip,
    });

    res.json(updated);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
    }
    logger.error(`POST /restaurants/:restaurantId/bills/:billId/refund: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to process refund' } });
  }
}

// ---------------------------------------------------------------------
// GET /restaurants/:restaurantId/payments — view_payment_history
// (manager/owner/system_admin).
// ---------------------------------------------------------------------
export async function listPayments(req, res) {
  const { restaurantId } = req.params;
  try {
    const transactions = await billModel.findTransactionsForRestaurant(restaurantId);
    res.json({ data: transactions });
  } catch (err) {
    logger.error(`GET /restaurants/:restaurantId/payments: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load payment history' } });
  }
}

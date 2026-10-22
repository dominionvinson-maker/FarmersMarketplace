const express = require('express');
const { pool } = require('../db');
const { getMonthRangeUtc } = require('../utils/dateRange');
const logger = require('../utils/logger');

const router = express.Router();

// Statuses that represent committed spend for the current month. Orders keep
// counting toward the budget as they progress through fulfilment so the same
// money cannot be spent twice in one month.
const SPEND_STATUSES = [
  'pending',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'released',
  'disputed',
  'completed',
];

// Process-local mutex used only as a fallback for SQLite. Postgres uses an
// advisory lock that is held for the lifetime of the order transaction.
const userLocks = new Map();

function acquireUserLock(userId) {
  const key = String(userId);
  const previous = userLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  userLocks.set(
    key,
    previous.then(() => current)
  );
  return previous.then(() => release);
}

/**
 * Compute the authoritative total for a new order on the server. The client
 * never supplies a price; it is derived from the product and quantity.
 */
async function computeOrderTotal(db, { product_id, quantity }) {
  const qty = Number(quantity) || 1;
  const result = await db.query(
    'SELECT price FROM products WHERE id = $1',
    [product_id]
  );
  if (!result.rows.length) {
    return null;
  }
  const unitPrice = Number(result.rows[0].price) || 0;
  return unitPrice * qty;
}

/**
 * Sum the buyer's committed spend for the current UTC month. Uses a
 * format-agnostic comparison so SQLite's `CURRENT_TIMESTAMP` text format
 * (`YYYY-MM-DD HH:MM:SS`) matches the ISO range bounds.
 */
async function getMonthlySpend(db, userId, isSqlite) {
  const { start, end } = getMonthRangeUtc();
  const placeholders = SPEND_STATUSES.map((_, i) => `$${i + 3}`).join(', ');
  const startParam = isSqlite ? start.replace('T', ' ').replace('Z', '') : start;
  const endParam = isSqlite ? end.replace('T', ' ').replace('Z', '') : end;
  const result = await db.query(
    `SELECT COALESCE(SUM(total_price), 0) AS spent
       FROM orders
      WHERE user_id = $1
        AND created_at >= $2
        AND created_at < $3
        AND status IN (${placeholders})`,
    [userId, startParam, endParam, ...SPEND_STATUSES]
  );
  return Number(result.rows[0]?.spent) || 0;
}

/**
 * Enforce the buyer's monthly budget for a new order. Must be called inside
 * the order transaction so the lock is held until the order row is committed.
 * Returns { ok: true } or { ok: false, status, error }.
 */
async function enforceBudget(db, userId, orderTotal, isSqlite) {
  const budgetResult = await db.query(
    'SELECT limit_xlm FROM wallet_budgets WHERE user_id = $1',
    [userId]
  );
  if (!budgetResult.rows.length) {
    return { ok: true };
  }
  const limit = Number(budgetResult.rows[0].limit_xlm);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { ok: true };
  }
  const spent = await getMonthlySpend(db, userId, isSqlite);
  if (spent + orderTotal > limit) {
    return {
      ok: false,
      status: 402,
      error: 'budget_exceeded',
      message: 'Monthly spending budget exceeded',
    };
  }
  return { ok: true };
}

// Legacy middleware entry point. The authoritative check now lives inside the
// order transaction in orders.js; this remains for callers that still mount it.
router.use(async (req, res, next) => {
  const userId = req.user?.id;
  if (!userId) {
    return next();
  }

  const isSqlite = pool.dialect === 'sqlite' || pool.isSqlite === true;
  let release = null;
  let client = null;

  try {
    if (isSqlite) {
      release = await acquireUserLock(userId);
    } else {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [userId]);
    }

    const db = client || pool;
    const orderTotal = await computeOrderTotal(db, req.body || {});
    if (orderTotal === null) {
      if (client) {
        await client.query('ROLLBACK');
      }
      if (release) {
        release();
      }
      return res.status(400).json({ error: 'invalid_product' });
    }

    const result = await enforceBudget(db, userId, orderTotal, isSqlite);
    if (!result.ok) {
      if (client) {
        await client.query('ROLLBACK');
      }
      if (release) {
        release();
      }
      return res.status(result.status).json({
        error: result.error,
        message: result.message,
      });
    }

    // Attach the server-computed total so the order handler does not trust a
    // client-supplied price.
    req.orderTotal = orderTotal;

    if (client) {
      // Keep the transaction (and advisory lock) open until the order handler
      // finishes writing the row, then commit.
      res.on('finish', async () => {
        try {
          await client.query('COMMIT');
        } catch (err) {
          logger.error('orderBudgetGuard commit failed', err);
        } finally {
          client.release();
        }
      });
      res.on('close', async () => {
        if (!res.writableEnded) {
          try {
            await client.query('ROLLBACK');
          } catch (err) {
            logger.error('orderBudgetGuard rollback failed', err);
          } finally {
            client.release();
          }
        }
      });
      req.dbClient = client;
    }

    if (release) {
      // Hold the SQLite mutex until the response is fully written.
      res.on('finish', release);
      res.on('close', release);
    }

    return next();
  } catch (err) {
    logger.error('orderBudgetGuard error', err);
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('orderBudgetGuard rollback failed', rollbackErr);
      } finally {
        client.release();
      }
    }
    if (release) {
      release();
    }
    return res.status(500).json({ error: 'budget_check_failed' });
  }
});

module.exports = router;
module.exports.enforceBudget = enforceBudget;
module.exports.computeOrderTotal = computeOrderTotal;
module.exports.getMonthlySpend = getMonthlySpend;
module.exports.SPEND_STATUSES = SPEND_STATUSES;

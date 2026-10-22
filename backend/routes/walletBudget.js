const express = require('express');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { getMonthRangeUtc } = require('../utils/dateUtils');

const router = express.Router();

// All order statuses that represent committed spend for the month.
// Orders must keep counting toward the budget as they progress through
// fulfilment; only cancelled/refunded orders should free up budget again.
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

function isSqlite() {
  return (process.env.DB_CLIENT || '').toLowerCase() === 'sqlite';
}

// Build a month-window predicate that works for both Postgres (ISO timestamps)
// and SQLite (CURRENT_TIMESTAMP stored as 'YYYY-MM-DD HH:MM:SS').
function monthWindowClause(startParam, endParam) {
  if (isSqlite()) {
    // Normalise stored timestamps to ISO form before comparing so that the
    // space separator (0x20) does not sort before 'T' (0x54).
    return `datetime(replace(created_at, ' ', 'T')) >= datetime(${startParam}) AND datetime(replace(created_at, ' ', 'T')) < datetime(${endParam})`;
  }
  return `created_at >= ${startParam} AND created_at < ${endParam}`;
}

function statusPlaceholders(offset) {
  return SPEND_STATUSES.map((_, i) => `$${offset + i}`).join(', ');
}

async function getSpentXlm(userId) {
  const { start, end } = getMonthRangeUtc();
  const params = [userId, start, end, ...SPEND_STATUSES];
  const sql = `
    SELECT COALESCE(SUM(total_price), 0) AS spent
    FROM orders
    WHERE user_id = $1
      AND ${monthWindowClause('$2', '$3')}
      AND status IN (${statusPlaceholders(4)})
  `;
  const result = await pool.query(sql, params);
  const row = result.rows && result.rows[0];
  return Number(row?.spent ?? 0);
}

// GET /api/v1/wallet/budget
router.get('/budget', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const budgetResult = await pool.query(
      'SELECT limit_xlm FROM wallet_budgets WHERE user_id = $1',
      [userId]
    );
    const limitXlm = budgetResult.rows[0]?.limit_xlm ?? null;
    const spentXlm = await getSpentXlm(userId);

    res.json({
      limit_xlm: limitXlm === null ? null : Number(limitXlm),
      spent_xlm: spentXlm,
      remaining_xlm: limitXlm === null ? null : Math.max(0, Number(limitXlm) - spentXlm),
    });
  } catch (err) {
    console.error('Error fetching wallet budget:', err);
    res.status(500).json({ error: 'Failed to fetch budget' });
  }
});

// PUT /api/v1/wallet/budget
router.put('/budget', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const rawLimit = req.body?.limit_xlm;

    if (rawLimit === null || rawLimit === undefined) {
      await pool.query('DELETE FROM wallet_budgets WHERE user_id = $1', [userId]);
      return res.json({ limit_xlm: null });
    }

    const limitXlm = Number(rawLimit);
    if (!Number.isFinite(limitXlm) || limitXlm < 0) {
      return res.status(400).json({ error: 'limit_xlm must be a non-negative number' });
    }

    await pool.query(
      `INSERT INTO wallet_budgets (user_id, limit_xlm)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET limit_xlm = EXCLUDED.limit_xlm`,
      [userId, limitXlm]
    );

    res.json({ limit_xlm: limitXlm });
  } catch (err) {
    console.error('Error updating wallet budget:', err);
    res.status(500).json({ error: 'Failed to update budget' });
  }
});

module.exports = router;
module.exports.SPEND_STATUSES = SPEND_STATUSES;
module.exports.getSpentXlm = getSpentXlm;

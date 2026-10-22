'use strict';

/**
 * Deactivate expired products.
 *
 * Runs daily at 02:00. Products whose `best_before` is in the past are
 * deactivated so they can no longer be ordered.
 *
 * BE-43: this job previously shared `expiry_notified_at` with the freshness
 * alert job, so any product that had already been warned about (i.e. every
 * product with a `best_before` at least one day out) was skipped forever.
 * It now uses its own `expired_at` column. The batch loop also uses keyset
 * pagination instead of OFFSET so rows dropping out of the WHERE clause
 * don't cause later rows to be skipped.
 */

const { db } = require('../db');
const logger = require('../utils/logger');

const BATCH_SIZE = 100;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fetch the next batch of expired, still-active products using keyset
 * pagination. Returns rows ordered by id ascending, all with id > lastId.
 */
async function fetchExpiredBatch(lastId, limit) {
  const today = todayIso();

  if (db.isSqlite) {
    // SQLite branch: use the DB layer's query API (db.prepare is not provided).
    return db.all(
      `SELECT p.id, p.farmer_id, p.name, p.best_before
         FROM products p
        WHERE p.active = 1
          AND p.best_before IS NOT NULL
          AND p.best_before < ?
          AND p.expired_at IS NULL
          AND p.id > ?
        ORDER BY p.id ASC
        LIMIT ?`,
      [today, lastId, limit]
    );
  }

  const result = await db.query(
    `SELECT p.id, p.farmer_id, p.name, p.best_before
       FROM products p
      WHERE p.active = 1
        AND p.best_before IS NOT NULL
        AND p.best_before < $1
        AND p.expired_at IS NULL
        AND p.id > $2
      ORDER BY p.id ASC
      LIMIT $3`,
    [today, lastId, limit]
  );
  return result.rows;
}

async function deactivateBatch(rows) {
  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id);
  const now = new Date().toISOString();

  if (db.isSqlite) {
    const placeholders = ids.map(() => '?').join(', ');
    const info = await db.run(
      `UPDATE products
          SET active = 0,
              expired_at = ?
        WHERE id IN (${placeholders})
          AND active = 1`,
      [now, ...ids]
    );
    return info && typeof info.changes === 'number' ? info.changes : ids.length;
  }

  const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
  const result = await db.query(
    `UPDATE products
        SET active = 0,
            expired_at = $1
      WHERE id IN (${placeholders})
        AND active = 1`,
    [now, ...ids]
  );
  return result.rowCount || 0;
}

async function runDeactivateExpiredProducts() {
  let lastId = 0;
  let deactivated = 0;
  let batches = 0;

  // Keyset pagination: always advance past the highest id we've seen so
  // rows leaving the result set (because they were just deactivated) can't
  // shift the window and cause rows to be skipped.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await fetchExpiredBatch(lastId, BATCH_SIZE);
    if (!rows || rows.length === 0) break;

    const changed = await deactivateBatch(rows);
    deactivated += changed;
    batches += 1;

    lastId = rows[rows.length - 1].id;

    if (rows.length < BATCH_SIZE) break;
  }

  logger.info(
    `[deactivateExpiredProducts] deactivated ${deactivated} product(s) in ${batches} batch(es)`
  );

  return { deactivated };
}

module.exports = {
  runDeactivateExpiredProducts,
  fetchExpiredBatch,
};

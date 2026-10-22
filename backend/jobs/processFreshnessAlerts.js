const db = require('../db');
const { sendEmail } = require('../services/email');
const logger = require('../utils/logger');

const FRESHNESS_ALERT_DAYS = parseInt(process.env.FRESHNESS_ALERT_DAYS, 10) || 3;

function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function daysLeft(bestBefore) {
  const bb = new Date(bestBefore);
  const bbDay = new Date(Date.UTC(bb.getUTCFullYear(), bb.getUTCMonth(), bb.getUTCDate()));
  return Math.round((bbDay - todayUTC()) / 86400000);
}

async function fetchExpiringProducts() {
  const today = todayUTC();
  const horizon = new Date(today.getTime() + FRESHNESS_ALERT_DAYS * 86400000);
  const todayStr = today.toISOString().slice(0, 10);
  const horizonStr = horizon.toISOString().slice(0, 10);

  const sql = `
    SELECT p.id, p.name, p.best_before, p.farmer_id, p.quantity,
           u.email AS farmer_email, u.name AS farmer_name
    FROM products p
    JOIN users u ON u.id = p.farmer_id
    WHERE p.active = 1
      AND p.quantity > 0
      AND p.best_before IS NOT NULL
      AND p.best_before >= ?
      AND p.best_before <= ?
      AND p.freshness_alerted_at IS NULL
      AND (u.banned IS NULL OR u.banned = 0)
      AND (u.deactivated_at IS NULL)
    ORDER BY p.id
  `;

  return db.all(sql, [todayStr, horizonStr]);
}

async function markAlerted(productId) {
  await db.run(
    'UPDATE products SET freshness_alerted_at = CURRENT_TIMESTAMP WHERE id = ?',
    [productId]
  );
}

async function runFreshnessAlerts() {
  const products = await fetchExpiringProducts();
  let alerted = 0;

  for (const product of products) {
    try {
      const remaining = daysLeft(product.best_before);
      const when = remaining <= 0 ? 'today' : `in ${remaining} day${remaining === 1 ? '' : 's'}`;

      if (product.farmer_email) {
        await sendEmail({
          to: product.farmer_email,
          subject: `Freshness alert: ${product.name} expires ${when}`,
          text: `Hi ${product.farmer_name || 'there'},\n\nYour product "${product.name}" expires ${when}. Consider discounting it or removing it from sale.\n\n— The Farm Team`,
        });
      }

      await markAlerted(product.id);
      alerted += 1;
    } catch (err) {
      logger.error(`Freshness alert failed for product ${product.id}: ${err.message}`);
    }
  }

  return { alerted };
}

module.exports = { runFreshnessAlerts, fetchExpiringProducts, daysLeft };

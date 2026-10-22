-- BE-43: split products.expiry_notified_at into two distinct columns.
--
-- `expiry_notified_at` was overloaded: processFreshnessAlerts set it when a
-- product was *warned* about (best_before within N days), while
-- deactivateExpiredProducts used it as a "already deactivated" marker. Because
-- the freshness job set it first, the deactivation job's `IS NULL` filter
-- skipped every warned product, so expired products were never deactivated.
--
-- This migration introduces:
--   freshness_alerted_at  -> set by processFreshnessAlerts ("expiring soon" sent)
--   expired_at            -> set by deactivateExpiredProducts ("deactivated")
-- and backfills from the old column before dropping it.

ALTER TABLE products ADD COLUMN freshness_alerted_at DATETIME;
ALTER TABLE products ADD COLUMN expired_at DATETIME;

-- Products that were already deactivated had expiry_notified_at set by the
-- deactivation job; record that as expired_at.
UPDATE products
SET expired_at = expiry_notified_at
WHERE active = 0 AND expiry_notified_at IS NOT NULL;

-- Products still active but flagged were freshness-warned (the deactivation
-- job never touched active rows), so carry the value over as a freshness alert.
UPDATE products
SET freshness_alerted_at = expiry_notified_at
WHERE active = 1 AND expiry_notified_at IS NOT NULL;

ALTER TABLE products DROP COLUMN expiry_notified_at;

CREATE INDEX IF NOT EXISTS idx_products_freshness_alerted_at
  ON products (freshness_alerted_at);
CREATE INDEX IF NOT EXISTS idx_products_expired_at
  ON products (expired_at);

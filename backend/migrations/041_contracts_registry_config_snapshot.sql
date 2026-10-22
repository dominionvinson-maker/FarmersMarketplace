-- Migration: 041_contracts_registry_config_snapshot
-- Stores the last on-chain get_config() result per contract (CT-28)

ALTER TABLE contracts_registry ADD COLUMN config_snapshot TEXT;
ALTER TABLE contracts_registry ADD COLUMN config_synced_at TEXT;

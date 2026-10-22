-- Rollback: 041_contracts_registry_config_snapshot

ALTER TABLE contracts_registry DROP COLUMN IF EXISTS config_snapshot;
ALTER TABLE contracts_registry DROP COLUMN IF EXISTS config_synced_at;

-- Keycloak PostgreSQL Performance Indexes
-- Run after Keycloak initial schema creation
--
-- These indexes optimize lookups for X3/IRC-specific user attributes:
-- - SCRAM credentials (x3_scram_*)
-- - X.509 fingerprints (x509_fingerprints)
-- - OpServ level (x3_opserv_level)

-- Composite index for attribute lookups by name
-- Speeds up: "Find all users with attribute X" and "Get attribute X for user Y"
CREATE INDEX IF NOT EXISTS idx_user_attribute_name
  ON user_attribute (name);

-- Composite index for value lookups (used for fingerprint searches)
-- Speeds up: "Find user with x509_fingerprints = '...'"
CREATE INDEX IF NOT EXISTS idx_user_attribute_name_value
  ON user_attribute (name, value)
  WHERE name IN ('x509_fingerprints', 'x3_opserv_level');

-- Partial index for SCRAM attributes specifically
-- These are queried together when fetching SCRAM credentials
CREATE INDEX IF NOT EXISTS idx_user_attribute_scram
  ON user_attribute (user_id, name)
  WHERE name LIKE 'x3_scram_%';

-- Index for fingerprint lookups (most common SASL EXTERNAL query)
CREATE INDEX IF NOT EXISTS idx_user_attribute_fingerprints
  ON user_attribute (value)
  WHERE name = 'x509_fingerprints';

-- Analyze tables after index creation
ANALYZE user_attribute;

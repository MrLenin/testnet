-- Keycloak PostgreSQL Performance Indexes for X3/IRC Integration
-- Run after Keycloak initial schema creation
--
-- These indexes optimize lookups for X3/IRC-specific operations:
-- - User attributes (SCRAM, x509, opserv level, channel access)
-- - Credentials (password validation)
-- - Event logging
--
-- NOTE: Channel access is stored in USER_ATTRIBUTE, not group memberships.
-- Groups are only used for x3-opers (network operator status).

-- =============================================================================
-- USER_ATTRIBUTE indexes (primary storage for IRC data)
-- =============================================================================

-- General attribute name lookup
-- Speeds up: "Get all attributes with name X"
CREATE INDEX IF NOT EXISTS idx_user_attribute_name
  ON user_attribute (name);

-- User + name composite for fetching specific user's attributes
-- Speeds up: "Get attribute X for user Y"
CREATE INDEX IF NOT EXISTS idx_user_attribute_user_name
  ON user_attribute (user_id, name);

-- Partial index for SCRAM attributes (queried together during SASL)
CREATE INDEX IF NOT EXISTS idx_user_attribute_scram
  ON user_attribute (user_id, name)
  WHERE name LIKE 'x3_scram_%';

-- Value index for fingerprint lookups (SASL EXTERNAL)
-- Speeds up: "Find user with x509_fingerprints = 'AA:BB:...'"
CREATE INDEX IF NOT EXISTS idx_user_attribute_fingerprints
  ON user_attribute (value)
  WHERE name = 'x509_fingerprints';

-- Partial index for opserv level lookups
CREATE INDEX IF NOT EXISTS idx_user_attribute_opserv
  ON user_attribute (user_id, value)
  WHERE name = 'x3_opserv_level';

-- Partial index for ChanServ channel access attributes
-- Channel access stored as: chanserv_#channel = access_level
-- Speeds up: "What channels does user X have access to?"
CREATE INDEX IF NOT EXISTS idx_user_attribute_chanserv
  ON user_attribute (user_id, name, value)
  WHERE name LIKE 'chanserv_%';

-- Reverse lookup for channel access
-- Speeds up: "Who has access to #channel?"
CREATE INDEX IF NOT EXISTS idx_user_attribute_chanserv_by_name
  ON user_attribute (name, value)
  WHERE name LIKE 'chanserv_%';

-- =============================================================================
-- GROUP indexes (x3-opers network operator group only)
-- =============================================================================

-- Group name lookup (for x3-opers group)
CREATE INDEX IF NOT EXISTS idx_keycloak_group_name
  ON keycloak_group (name);

-- Realm + name for realm-scoped group lookups
CREATE INDEX IF NOT EXISTS idx_keycloak_group_realm_name
  ON keycloak_group (realm_id, name);

-- =============================================================================
-- USER_GROUP_MEMBERSHIP indexes (x3-opers membership)
-- =============================================================================

-- User's group memberships (for checking oper status)
CREATE INDEX IF NOT EXISTS idx_user_group_membership_user
  ON user_group_membership (user_id);

-- Group's members (for listing all opers)
CREATE INDEX IF NOT EXISTS idx_user_group_membership_group
  ON user_group_membership (group_id);

-- =============================================================================
-- CREDENTIAL indexes (password/SCRAM validation)
-- =============================================================================

-- User's credentials by type
-- Speeds up: "Get password credential for user X"
CREATE INDEX IF NOT EXISTS idx_credential_user_type
  ON credential (user_id, type);

-- =============================================================================
-- FED_USER_ATTRIBUTE indexes (if using federated identity)
-- =============================================================================

-- Federated user attributes (for LDAP/external IdP users)
CREATE INDEX IF NOT EXISTS idx_fed_user_attribute_user_name
  ON fed_user_attribute (user_id, name);

-- =============================================================================
-- EVENT_ENTITY indexes (webhook event processing, audit)
-- =============================================================================

-- Events by type and time (for webhook replay, debugging)
CREATE INDEX IF NOT EXISTS idx_event_entity_type_time
  ON event_entity (type, event_time DESC);

-- Events by user (for audit trail)
CREATE INDEX IF NOT EXISTS idx_event_entity_user
  ON event_entity (user_id, event_time DESC);

-- =============================================================================
-- USER_ENTITY indexes (user lookups)
-- =============================================================================

-- Username lookup (case-insensitive IRC nick matching)
CREATE INDEX IF NOT EXISTS idx_user_entity_username_lower
  ON user_entity (lower(username));

-- Email lookup
CREATE INDEX IF NOT EXISTS idx_user_entity_email_lower
  ON user_entity (lower(email));

-- Realm + username for efficient user resolution
CREATE INDEX IF NOT EXISTS idx_user_entity_realm_username
  ON user_entity (realm_id, username);

-- =============================================================================
-- Analyze all modified tables
-- =============================================================================

ANALYZE user_attribute;
ANALYZE keycloak_group;
ANALYZE user_group_membership;
ANALYZE credential;
ANALYZE fed_user_attribute;
ANALYZE event_entity;
ANALYZE user_entity;

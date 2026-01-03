#!/bin/bash
# Setup Keycloak realm and clients for IRC testnet
# This script configures Keycloak for use with X3 services and Nefarious IAUTH

set -e

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
ADMIN_USER="${KEYCLOAK_ADMIN:-admin}"
ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
REALM_NAME="testnet"

echo "=== Keycloak IRC Testnet Setup ==="
echo "Keycloak URL: $KEYCLOAK_URL"
echo "Realm: $REALM_NAME"

# Function to get/refresh admin token
get_admin_token() {
  curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=$ADMIN_USER" \
    -d "password=$ADMIN_PASS" \
    -d "grant_type=password" \
    -d "client_id=admin-cli" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4
}

# Get admin token
echo ""
echo "Getting admin token..."
TOKEN=$(get_admin_token)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get admin token. Is Keycloak running?"
  exit 1
fi
echo "Got admin token"

# Increase admin-cli token lifespan in master realm (default is 60 seconds!)
echo "Configuring admin-cli token lifespan..."
ADMIN_CLI_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$KEYCLOAK_URL/admin/realms/master/clients?clientId=admin-cli" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$ADMIN_CLI_ID" ]; then
  curl -s -X PUT "$KEYCLOAK_URL/admin/realms/master/clients/$ADMIN_CLI_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "clientId": "admin-cli",
      "attributes": {
        "access.token.lifespan": "900"
      }
    }' 2>/dev/null || true
  echo "  admin-cli token lifespan set to 15 minutes"

  # Refresh token after updating lifespan
  TOKEN=$(get_admin_token)
fi

# Check if realm exists
REALM_EXISTS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME")

if [ "$REALM_EXISTS" = "200" ]; then
  echo "Realm '$REALM_NAME' already exists, updating settings..."
  # Update realm settings for IRC compatibility
  curl -s -X PUT "$KEYCLOAK_URL/admin/realms/$REALM_NAME" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "enabled": true,
      "registrationAllowed": true,
      "registrationEmailAsUsername": false,
      "verifyEmail": false,
      "loginWithEmailAllowed": false,
      "duplicateEmailsAllowed": true,
      "resetPasswordAllowed": true,
      "editUsernameAllowed": false,
      "bruteForceProtected": false,
      "permanentLockout": false,
      "maxFailureWaitSeconds": 0,
      "minimumQuickLoginWaitSeconds": 0,
      "waitIncrementSeconds": 0,
      "quickLoginCheckMilliSeconds": 1000,
      "maxDeltaTimeSeconds": 43200,
      "failureFactor": 30,
      "requiredActions": []
    }'
  echo "Realm updated"
else
  echo "Creating realm '$REALM_NAME'..."
  curl -s -X POST "$KEYCLOAK_URL/admin/realms" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "realm": "'"$REALM_NAME"'",
      "enabled": true,
      "registrationAllowed": true,
      "registrationEmailAsUsername": false,
      "verifyEmail": false,
      "loginWithEmailAllowed": false,
      "duplicateEmailsAllowed": true,
      "resetPasswordAllowed": true,
      "editUsernameAllowed": false,
      "bruteForceProtected": false,
      "permanentLockout": false,
      "maxFailureWaitSeconds": 0,
      "minimumQuickLoginWaitSeconds": 0,
      "waitIncrementSeconds": 0,
      "quickLoginCheckMilliSeconds": 1000,
      "maxDeltaTimeSeconds": 43200,
      "failureFactor": 30,
      "requiredActions": []
    }'
  echo "Realm created"
fi

# =============================================================================
# X.509 Authentication Flow Configuration (Scenario 2 - Future)
# =============================================================================
# This section configures Keycloak's built-in X.509 authenticator for direct
# certificate validation. This is NOT required for Scenario 1 (X3-managed
# fingerprint lookup via Admin API), but is set up for future use.
#
# Certificate source options for Scenario 2:
#   1. Direct TLS termination at Keycloak
#   2. Reverse proxy (nginx/HAProxy) forwarding cert via headers
#   3. API call from X3 with certificate data
#
# For proxy setups, Keycloak needs these headers configured:
#   - X-SSL-Client-Cert (PEM-encoded certificate)
#   - Or X-SSL-Client-Cert-Chain for full chain
# =============================================================================
# NOTE: X.509 flow configuration is commented out for now as it's not needed
# for current SASL EXTERNAL implementation (Scenario 1 - X3 Admin API lookup).
# Uncomment this section when implementing Scenario 2.
#
# echo ""
# echo "Configuring X.509 authentication flow (for future Scenario 2)..."
#
# # Check if x509-browser flow already exists
# X509_FLOW_EXISTS=$(curl -s \
#   -H "Authorization: Bearer $TOKEN" \
#   "$KEYCLOAK_URL/admin/realms/$REALM_NAME/authentication/flows" | grep -o '"alias":"x509-browser"')
#
# if [ -z "$X509_FLOW_EXISTS" ]; then
#   echo "Creating X.509 browser authentication flow..."
#
#   # Copy the browser flow
#   curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/authentication/flows/browser/copy" \
#     -H "Authorization: Bearer $TOKEN" \
#     -H "Content-Type: application/json" \
#     -d '{"newName": "x509-browser"}'
#
#   # Get the new flow ID
#   X509_FLOW_ID=$(curl -s \
#     -H "Authorization: Bearer $TOKEN" \
#     "$KEYCLOAK_URL/admin/realms/$REALM_NAME/authentication/flows?search=x509-browser" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
#
#   if [ -n "$X509_FLOW_ID" ]; then
#     # Add X.509 authenticator execution to the flow
#     curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/authentication/flows/x509-browser/executions/execution" \
#       -H "Authorization: Bearer $TOKEN" \
#       -H "Content-Type: application/json" \
#       -d '{"provider": "auth-x509-client-username-form"}'
#
#     echo "  X.509 browser flow created"
#
#     # Get the X.509 execution to configure it
#     X509_EXEC=$(curl -s \
#       -H "Authorization: Bearer $TOKEN" \
#       "$KEYCLOAK_URL/admin/realms/$REALM_NAME/authentication/flows/x509-browser/executions" | \
#       grep -o '"id":"[^"]*","authenticator":"auth-x509-client-username-form"' | head -1 | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
#
#     if [ -n "$X509_EXEC" ]; then
#       # Configure X.509 authenticator - use fingerprint for user identity mapping
#       # This matches users by their x509_fingerprints attribute
#       curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/authentication/executions/$X509_EXEC/config" \
#         -H "Authorization: Bearer $TOKEN" \
#         -H "Content-Type: application/json" \
#         -d '{
#           "alias": "x509-config",
#           "config": {
#             "x509-cert-auth.mapper-selection": "Custom Attribute Mapper",
#             "x509-cert-auth.mapper-selection.user-attribute-name": "x509_fingerprints",
#             "x509-cert-auth.mapping-source-selection": "SHA-256 Thumbprint (hex)",
#             "x509-cert-auth.regular-expression": "(.*)",
#             "x509-cert-auth.timestamp-validation-enabled": "false",
#             "x509-cert-auth.crl-checking-enabled": "false",
#             "x509-cert-auth.ocsp-checking-enabled": "false"
#           }
#         }'
#       echo "  X.509 authenticator configured (fingerprint-based, no CRL/OCSP)"
#       echo "  Note: This flow is not active by default. To use Scenario 2:"
#       echo "        - Set x509-browser as the browser flow binding in realm settings"
#       echo "        - Configure TLS client cert at Keycloak or proxy"
#     fi
#   fi
# else
#   echo "X.509 browser flow already exists"
# fi
echo ""
echo "Skipping X.509 authentication flow (Scenario 2 - not currently needed)"

# Configure user profile for IRC use:
# - username and email are required
# - firstName, lastName are optional (no "required" field = not required)
echo ""
echo "Configuring user profile for IRC (username and email required)..."
USER_PROFILE=$(cat <<'PROFILE_EOF'
{
  "unmanagedAttributePolicy": "ADMIN_EDIT",
  "attributes": [
    {
      "name": "username",
      "displayName": "${username}",
      "validations": {
        "length": { "min": 2, "max": 30 },
        "username-prohibited-characters": {},
        "up-username-not-idn-homograph": {}
      },
      "required": {
        "roles": ["user"]
      },
      "permissions": {
        "view": ["admin", "user"],
        "edit": ["admin"]
      },
      "multivalued": false
    },
    {
      "name": "email",
      "displayName": "${email}",
      "validations": {
        "email": {},
        "length": { "max": 255 }
      },
      "required": {
        "roles": ["user"]
      },
      "permissions": {
        "view": ["admin", "user"],
        "edit": ["admin", "user"]
      },
      "multivalued": false
    },
    {
      "name": "firstName",
      "displayName": "${firstName}",
      "validations": {
        "length": { "max": 255 },
        "person-name-prohibited-characters": {}
      },
      "permissions": {
        "view": ["admin", "user"],
        "edit": ["admin", "user"]
      },
      "multivalued": false
    },
    {
      "name": "lastName",
      "displayName": "${lastName}",
      "validations": {
        "length": { "max": 255 },
        "person-name-prohibited-characters": {}
      },
      "permissions": {
        "view": ["admin", "user"],
        "edit": ["admin", "user"]
      },
      "multivalued": false
    },
    {
      "name": "x3_opserv_level",
      "displayName": "X3 OpServ Level",
      "validations": {
        "pattern": { "pattern": "^[0-9]*$", "error-message": "Must be a number" }
      },
      "permissions": {
        "view": ["admin"],
        "edit": ["admin"]
      },
      "multivalued": false,
      "group": "x3-attributes"
    },
    {
      "name": "x509_fingerprints",
      "displayName": "X.509 Certificate Fingerprints",
      "annotations": {
        "inputHelperTextBefore": "SHA-256 fingerprints of client certificates for SASL EXTERNAL authentication"
      },
      "validations": {
        "pattern": { "pattern": "^[A-Fa-f0-9:]{95}$", "error-message": "Must be SHA-256 fingerprint (64 hex chars with colons)" }
      },
      "permissions": {
        "view": ["admin"],
        "edit": ["admin"]
      },
      "multivalued": true,
      "group": "x3-attributes"
    }
  ],
  "groups": [
    {
      "name": "user-metadata",
      "displayHeader": "User metadata",
      "displayDescription": "Attributes, which refer to user metadata"
    },
    {
      "name": "x3-attributes",
      "displayHeader": "X3 Services",
      "displayDescription": "Attributes managed by X3 IRC Services"
    }
  ]
}
PROFILE_EOF
)

curl -s -X PUT "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users/profile" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$USER_PROFILE" > /dev/null
echo "User profile configured (username required, email/name optional)"

# Create X3 Services client (for X3 to manage users)
echo ""
echo "Checking X3 services client..."
X3_CLIENT_EXISTS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=x3-services")

# Get client list to check if x3-services exists
X3_CLIENT=$(curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=x3-services" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$X3_CLIENT" ]; then
  echo "X3 services client already exists (id: $X3_CLIENT)"
else
  echo "Creating X3 services client..."
  curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "clientId": "x3-services",
      "name": "X3 IRC Services",
      "description": "X3 services bot - manages IRC accounts",
      "enabled": true,
      "clientAuthenticatorType": "client-secret",
      "secret": "x3-services-secret",
      "serviceAccountsEnabled": true,
      "authorizationServicesEnabled": false,
      "standardFlowEnabled": false,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": true,
      "publicClient": false,
      "protocol": "openid-connect"
    }'
  echo "X3 services client created"

  # Get the client ID
  X3_CLIENT=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=x3-services" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  # Get service account user and assign realm-admin role for full access
  echo "Setting up service account permissions..."
  SERVICE_USER=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$X3_CLIENT/service-account-user" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

  if [ -n "$SERVICE_USER" ]; then
    # Get realm-management client ID
    REALM_MGMT=$(curl -s \
      -H "Authorization: Bearer $TOKEN" \
      "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=realm-management" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -n "$REALM_MGMT" ]; then
      # Get realm-admin role (composite role with all permissions)
      REALM_ADMIN_ROLE=$(curl -s \
        -H "Authorization: Bearer $TOKEN" \
        "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$REALM_MGMT/roles/realm-admin")

      # Assign realm-admin role to service account
      curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users/$SERVICE_USER/role-mappings/clients/$REALM_MGMT" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "[$REALM_ADMIN_ROLE]"

      echo "Service account granted realm-admin role"
    fi
  fi
fi

# Ensure service account has realm-admin even if client existed
echo ""
echo "Verifying X3 service account permissions..."
X3_CLIENT=$(curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=x3-services" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$X3_CLIENT" ]; then
  SERVICE_USER=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$X3_CLIENT/service-account-user" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

  REALM_MGMT=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=realm-management" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$SERVICE_USER" ] && [ -n "$REALM_MGMT" ]; then
    REALM_ADMIN_ROLE=$(curl -s \
      -H "Authorization: Bearer $TOKEN" \
      "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$REALM_MGMT/roles/realm-admin")

    curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users/$SERVICE_USER/role-mappings/clients/$REALM_MGMT" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "[$REALM_ADMIN_ROLE]" 2>/dev/null || true

    echo "Service account permissions verified"
  fi
fi

# Create IRC client (for SASL authentication from IRC clients)
echo ""
echo "Checking IRC client..."
IRC_CLIENT=$(curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=irc-client" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$IRC_CLIENT" ]; then
  echo "IRC client already exists (id: $IRC_CLIENT)"
  # Update token lifespan for existing client
  echo "  Updating token lifespan settings..."
  # IRC sessions are long-lived - tokens should last at least a week
  # access.token.lifespan: 604800 (7 days)
  # offline.session: 2592000 (30 days) for refresh tokens
  curl -s -X PUT "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$IRC_CLIENT" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "clientId": "irc-client",
      "attributes": {
        "access.token.lifespan": "604800",
        "client.offline.session.idle.timeout": "2592000",
        "client.offline.session.max.lifespan": "2592000"
      }
    }' 2>/dev/null || true
  echo "  Token lifespan: 7 days access, 30 days refresh (IRC sessions are long-lived)"
else
  echo "Creating IRC client..."
  # IRC sessions are long-lived - tokens should last at least a week
  # access.token.lifespan: 604800 (7 days)
  # offline.session: 2592000 (30 days) for refresh tokens
  curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "clientId": "irc-client",
      "name": "IRC Client Authentication",
      "description": "Used by IRC clients for SASL OAUTHBEARER authentication",
      "enabled": true,
      "clientAuthenticatorType": "client-secret",
      "publicClient": true,
      "standardFlowEnabled": false,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": true,
      "protocol": "openid-connect",
      "attributes": {
        "access.token.lifespan": "604800",
        "client.offline.session.idle.timeout": "2592000",
        "client.offline.session.max.lifespan": "2592000"
      }
    }'
  echo "IRC client created (7-day access tokens for long IRC sessions)"

  # Get the new client ID for adding mappers
  IRC_CLIENT=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=irc-client" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

# Refresh token before mapper configuration
TOKEN=$(get_admin_token)

# Add protocol mappers to x3-services client (X3 authenticates using this client)
echo ""
echo "Configuring token mappers for x3-services client..."
if [ -n "$X3_CLIENT" ]; then
  # x3_opserv_level mapper
  MAPPER_EXISTS=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$X3_CLIENT/protocol-mappers/models" | grep -o '"name":"x3_opserv_level"' || true)

  if [ -z "$MAPPER_EXISTS" ]; then
    curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$X3_CLIENT/protocol-mappers/models" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{
        "name": "x3_opserv_level",
        "protocol": "openid-connect",
        "protocolMapper": "oidc-usermodel-attribute-mapper",
        "config": {
          "user.attribute": "x3_opserv_level",
          "claim.name": "x3_opserv_level",
          "jsonType.label": "String",
          "id.token.claim": "true",
          "access.token.claim": "true",
          "userinfo.token.claim": "true",
          "introspection.token.claim": "true"
        }
      }'
    echo "  x3_opserv_level mapper added"
  else
    echo "  x3_opserv_level mapper already exists"
  fi

  # x509_fingerprints mapper (for SASL EXTERNAL)
  FP_MAPPER_EXISTS=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$X3_CLIENT/protocol-mappers/models" | grep -o '"name":"x509_fingerprints"' || true)

  if [ -z "$FP_MAPPER_EXISTS" ]; then
    curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$X3_CLIENT/protocol-mappers/models" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{
        "name": "x509_fingerprints",
        "protocol": "openid-connect",
        "protocolMapper": "oidc-usermodel-attribute-mapper",
        "config": {
          "user.attribute": "x509_fingerprints",
          "claim.name": "x509_fingerprints",
          "jsonType.label": "String",
          "id.token.claim": "true",
          "access.token.claim": "true",
          "userinfo.token.claim": "true",
          "introspection.token.claim": "true",
          "multivalued": "true"
        }
      }'
    echo "  x509_fingerprints mapper added (for SASL EXTERNAL)"
  else
    echo "  x509_fingerprints mapper already exists"
  fi
else
  echo "  WARNING: X3_CLIENT not found, skipping mapper configuration"
fi

# Also add mappers to IRC client (for future use by IRC clients authenticating directly)
echo ""
echo "Configuring token mappers for IRC client..."
if [ -n "$IRC_CLIENT" ]; then
  # x3_opserv_level mapper
  MAPPER_EXISTS=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$IRC_CLIENT/protocol-mappers/models" | grep -o '"name":"x3_opserv_level"' || true)

  if [ -z "$MAPPER_EXISTS" ]; then
    curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$IRC_CLIENT/protocol-mappers/models" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{
        "name": "x3_opserv_level",
        "protocol": "openid-connect",
        "protocolMapper": "oidc-usermodel-attribute-mapper",
        "config": {
          "user.attribute": "x3_opserv_level",
          "claim.name": "x3_opserv_level",
          "jsonType.label": "String",
          "id.token.claim": "true",
          "access.token.claim": "true",
          "userinfo.token.claim": "true",
          "introspection.token.claim": "true"
        }
      }'
    echo "  x3_opserv_level mapper added"
  else
    echo "  x3_opserv_level mapper already exists"
  fi

  # x509_fingerprints mapper (for SASL EXTERNAL)
  FP_MAPPER_EXISTS=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$IRC_CLIENT/protocol-mappers/models" | grep -o '"name":"x509_fingerprints"' || true)

  if [ -z "$FP_MAPPER_EXISTS" ]; then
    curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$IRC_CLIENT/protocol-mappers/models" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{
        "name": "x509_fingerprints",
        "protocol": "openid-connect",
        "protocolMapper": "oidc-usermodel-attribute-mapper",
        "config": {
          "user.attribute": "x509_fingerprints",
          "claim.name": "x509_fingerprints",
          "jsonType.label": "String",
          "id.token.claim": "true",
          "access.token.claim": "true",
          "userinfo.token.claim": "true",
          "introspection.token.claim": "true",
          "multivalued": "true"
        }
      }'
    echo "  x509_fingerprints mapper added (for SASL EXTERNAL)"
  else
    echo "  x509_fingerprints mapper already exists"
  fi
fi

# Create x3-opers group
echo ""
echo "Checking x3-opers group..."
OPER_GROUP=$(curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME/groups?search=x3-opers&exact=true" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$OPER_GROUP" ]; then
  echo "x3-opers group already exists (id: $OPER_GROUP)"
else
  echo "Creating x3-opers group..."
  CREATE_RESULT=$(curl -s -w "\nHTTP:%{http_code}" -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/groups" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "x3-opers",
      "attributes": {
        "description": ["IRC Network Operators"]
      }
    }')
  HTTP_CODE=$(echo "$CREATE_RESULT" | grep "HTTP:" | cut -d: -f2)
  if [ "$HTTP_CODE" = "201" ]; then
    echo "x3-opers group created"
  else
    echo "ERROR: Failed to create x3-opers group (HTTP $HTTP_CODE)"
    echo "$CREATE_RESULT" | grep -v "^HTTP:"
  fi
fi

# Create irc-channels parent group for channel access storage
# X3 uses hierarchical groups like /irc-channels/#channel/owner for channel access
echo ""
echo "Checking irc-channels group (for ChanServ access storage)..."
CHANNELS_GROUP=$(curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME/groups?search=irc-channels&exact=true" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$CHANNELS_GROUP" ]; then
  echo "irc-channels group already exists (id: $CHANNELS_GROUP)"
else
  echo "Creating irc-channels group..."
  CREATE_RESULT=$(curl -s -w "\nHTTP:%{http_code}" -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/groups" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "irc-channels",
      "attributes": {
        "description": ["IRC Channel Access - subgroups created by X3 ChanServ"]
      }
    }')
  HTTP_CODE=$(echo "$CREATE_RESULT" | grep "HTTP:" | cut -d: -f2)
  if [ "$HTTP_CODE" = "201" ]; then
    echo "irc-channels group created"
    echo "  (X3 will create subgroups like /irc-channels/#channel/owner, /irc-channels/#channel/coowner, etc.)"
  else
    echo "ERROR: Failed to create irc-channels group (HTTP $HTTP_CODE)"
    echo "$CREATE_RESULT" | grep -v "^HTTP:"
  fi
fi

# Create/recreate test user with IRC-friendly settings
echo ""
echo "Setting up test user..."
TEST_USER=$(curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users?username=testuser&exact=true" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$TEST_USER" ]; then
  echo "Deleting existing testuser to recreate with current profile settings..."
  curl -s -X DELETE "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users/$TEST_USER" \
    -H "Authorization: Bearer $TOKEN"
fi

echo "Creating test user (username and email required)..."
CREATE_RESULT=$(curl -s -w "\nHTTP:%{http_code}" -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "email": "testuser@example.com",
    "enabled": true,
    "emailVerified": true,
    "requiredActions": [],
    "credentials": [{
      "type": "password",
      "value": "testpass",
      "temporary": false
    }]
  }')

HTTP_CODE=$(echo "$CREATE_RESULT" | grep "HTTP:" | cut -d: -f2)
if [ "$HTTP_CODE" = "201" ]; then
  echo "Test user created (username: testuser, password: testpass)"

  # Add a sample certificate fingerprint to the test user for SASL EXTERNAL testing
  # This uses a placeholder fingerprint - replace with actual cert fingerprint for testing
  TEST_USER_ID=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users?username=testuser&exact=true" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$TEST_USER_ID" ]; then
    # Set sample x509_fingerprints attribute (SHA-256 fingerprint format with colons)
    # Users can add real fingerprints via NickServ CERT ADD command
    # Note: Also include email to preserve it (partial PUT can overwrite user fields)
    curl -s -X PUT "$KEYCLOAK_URL/admin/realms/$REALM_NAME/users/$TEST_USER_ID" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{
        "email": "testuser@example.com",
        "emailVerified": true,
        "attributes": {
          "x509_fingerprints": ["AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"]
        }
      }'
    echo "  Added sample x509 fingerprint for SASL EXTERNAL testing"
  fi
else
  echo "Error creating test user: $CREATE_RESULT"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Keycloak Configuration for X3 (add to x3.conf in nickserv section):"
echo ""
echo '        "keycloak_enable" "1";'
echo '        "keycloak_uri" "http://keycloak:8080";'
echo '        "keycloak_realm" "testnet";'
echo '        "keycloak_client_id" "x3-services";'
echo '        "keycloak_client_secret" "x3-services-secret";'
echo '        "keycloak_autocreate" "1";'
echo '        "keycloak_oper_group" "x3-opers";'
echo '        "keycloak_oper_group_level" "99";'
echo '        "keycloak_attr_oslevel" "x3_opserv_level";'
echo '        "keycloak_attr_fingerprints" "x509_fingerprints";'
echo '        "keycloak_email_policy" "0";'
echo ""
echo "Keycloak URL (from host): http://localhost:8080"
echo "Keycloak URL (from containers): http://keycloak:8080"
echo "Admin console: http://localhost:8080/admin (admin/admin)"
echo "Test user: testuser / testpass"
echo ""
echo "=== SASL Mechanisms Supported ==="
echo "  PLAIN       - Username/password authentication"
echo "  EXTERNAL    - Client certificate fingerprint authentication"
echo "  OAUTHBEARER - OAuth 2.0 bearer token authentication"
echo ""
echo "=== SASL EXTERNAL Implementation ==="
echo ""
echo "Scenario 1 (Active - X3 Admin API Lookup):"
echo "  1. User connects with TLS client certificate"
echo "  2. IRC server extracts SHA-256 fingerprint, sends to X3"
echo "  3. X3 queries Keycloak Admin API for user with matching x509_fingerprints"
echo "  4. Keycloak returns username, X3 authenticates user"
echo ""
echo "Scenario 2 (Future - Keycloak Direct Validation):"
echo "  - x509-browser authentication flow is pre-configured but not active"
echo "  - Requires: Keycloak TLS client cert termination OR proxy header forwarding"
echo "  - To activate: Set x509-browser as browser flow in realm settings"
echo ""
echo "Certificate Management (via NickServ):"
echo "  /msg NickServ CERT ADD      - Add current cert fingerprint"
echo "  /msg NickServ CERT DEL <fp> - Remove fingerprint"
echo "  /msg NickServ CERT LIST     - List registered fingerprints"
echo ""
echo "Test fingerprint for testuser:"
echo "  AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"

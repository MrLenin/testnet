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

# Get admin token
echo ""
echo "Getting admin token..."
TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$ADMIN_USER" \
  -d "password=$ADMIN_PASS" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get admin token. Is Keycloak running?"
  exit 1
fi
echo "Got admin token"

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
      "bruteForceProtected": true,
      "permanentLockout": false,
      "maxFailureWaitSeconds": 900,
      "minimumQuickLoginWaitSeconds": 60,
      "waitIncrementSeconds": 60,
      "quickLoginCheckMilliSeconds": 1000,
      "maxDeltaTimeSeconds": 43200,
      "failureFactor": 30
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
      "bruteForceProtected": true,
      "permanentLockout": false,
      "maxFailureWaitSeconds": 900,
      "minimumQuickLoginWaitSeconds": 60,
      "waitIncrementSeconds": 60,
      "quickLoginCheckMilliSeconds": 1000,
      "maxDeltaTimeSeconds": 43200,
      "failureFactor": 30
    }'
  echo "Realm created"
fi

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
      "multivalued": false
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
else
  echo "Creating IRC client..."
  curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "clientId": "irc-client",
      "name": "IRC Client Authentication",
      "description": "Used by IRC clients for SASL authentication",
      "enabled": true,
      "clientAuthenticatorType": "client-secret",
      "publicClient": true,
      "standardFlowEnabled": false,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": true,
      "protocol": "openid-connect"
    }'
  echo "IRC client created"

  # Get the new client ID for adding mappers
  IRC_CLIENT=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=irc-client" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

# Add x3_opserv_level protocol mapper to IRC client (includes opserv level in tokens)
echo ""
echo "Configuring x3_opserv_level token mapper..."
if [ -n "$IRC_CLIENT" ]; then
  # Check if mapper already exists
  MAPPER_EXISTS=$(curl -s \
    -H "Authorization: Bearer $TOKEN" \
    "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$IRC_CLIENT/protocol-mappers/models" | grep -o '"name":"x3_opserv_level"')

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
          "jsonType.label": "int",
          "id.token.claim": "true",
          "access.token.claim": "true",
          "userinfo.token.claim": "true",
          "introspection.token.claim": "true"
        }
      }'
    echo "x3_opserv_level mapper added to IRC client"
  else
    echo "x3_opserv_level mapper already exists"
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
  curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/groups" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "x3-opers",
      "attributes": {
        "description": ["IRC Network Operators"]
      }
    }'
  echo "x3-opers group created"
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
  curl -s -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/groups" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "irc-channels",
      "attributes": {
        "description": ["IRC Channel Access - subgroups created by X3 ChanServ"]
      }
    }'
  echo "irc-channels group created"
  echo "  (X3 will create subgroups like /irc-channels/#channel/owner, /irc-channels/#channel/coowner, etc.)"
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
echo '        "keycloak_email_policy" "0";'
echo ""
echo "Keycloak URL (from host): http://localhost:8080"
echo "Keycloak URL (from containers): http://keycloak:8080"
echo "Admin console: http://localhost:8080/admin (admin/admin)"
echo "Test user: testuser / testpass"

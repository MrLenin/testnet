# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Afternet Testnet is a Docker-based IRC test environment running:
- **Nefarious IRCd** - IRC server daemon (git submodule from evilnet/nefarious2)
- **X3 Services** - Channel/nickname services (git submodule from evilnet/x3, branch `rubin-add_docker`)

## Build & Run Commands

```bash
# Build and start
docker compose build
docker compose up -d

# View logs
docker compose logs -f
docker compose logs nefarious
docker compose logs x3

# Stop
docker compose down
```

## Submodule Management

```bash
# Initialize (if cloned without --recurse-submodules)
git submodule update --init --recursive

# Update to latest remote
git submodule update --remote --merge

# Work on a submodule
cd nefarious  # or x3
git checkout -b feature-branch
# make changes, commit, push
cd ..
git add nefarious
git commit -m "Update nefarious submodule"
```

## Architecture

### Configuration System
Both services use environment variable templating:
1. Template files (`.conf-dist`) contain `%VARIABLE_NAME%` placeholders
2. Docker entry points (`dockerentrypoint.sh`) substitute environment variables via sed
3. Final configs written at container startup

Key config files:
- `.env` - X3 environment variables
- `nefarious/tools/docker/base.conf-dist` - IRCd config template
- `x3/docker/x3.conf-dist` - X3 config template

### Docker Structure
- Both containers built on Debian 12 using GNU Autotools
- Run as non-root user (UID/GID 1234)
- Docker bridge network: IPv4 10.1.2.0/24, IPv6 fec0:3200::1/64

### Ports
- 6667: IRC (plaintext)
- 4497: IRC (SSL)
- 9998: Services link

### Entry Points
- `nefarious/tools/docker/dockerentrypoint.sh` - Generates SSL certs, substitutes config
- `x3/docker/dockerentrypoint.sh` - Substitutes config

## Testing

Tests are in `tests/` directory using Vitest.

```bash
cd tests
IRC_HOST=localhost npm test -- src/path/to/test.ts  # Run specific test
```

**Important for Claude sessions:**
- DO NOT run the full test suite (`npm test`) - it takes 5+ minutes and will timeout
- Run specific test files instead: `npm test -- src/services/opserv.test.ts`
- For quick IRC testing, use `scripts/irc-test.sh`

### X3 Services Testing
- `createOperClient()` - Use for tests needing privileged O3 access (uses X3_ADMIN olevel 1000)
- `createX3Client()` - Use for regular non-privileged tests
- X3 interprets names as nicks by default; prefix with `*` for account names (e.g., `*accountname`)

### Admin Account
- `x3-admin-init` container auto-creates testadmin account on fresh starts
- First oper to register gets olevel 1000 (root access to O3)
- Credentials: X3_ADMIN=testadmin, X3_ADMIN_PASS=testadmin123

## X3 Services Architecture

### Service Bots
- **AuthServ** - Account registration/authentication
- **ChanServ** - Channel registration/management
- **OpServ (O3)** - Network operator commands (requires olevel)

### Communication Pattern
```
Client → Service:  PRIVMSG <Service> :<command>
Service → Client:  NOTICE <nick> :<response>
```

### OpServ Access Levels (olevel)
- 0-99: No oper access
- 100-199: Helper
- 200-399: Oper
- 400-599: Admin
- 600-899: Network Admin
- 900-999: Support
- 1000: Root (full access)

### ChanServ Access Levels
- 1-99: Peon/Voice
- 100-199: HalfOp
- 200-299: Op
- 300-399: Manager
- 400-499: Co-Owner
- 500+: Owner

### Common X3 Commands
```bash
# AuthServ
PRIVMSG AuthServ :REGISTER <account> <password> <email>
PRIVMSG AuthServ :AUTH <account> <password>
PRIVMSG AuthServ :COOKIE <account> <cookie>  # Activate account

# ChanServ
PRIVMSG ChanServ :REGISTER #channel
PRIVMSG ChanServ :ADDUSER #channel *account 200

# OpServ (requires olevel)
PRIVMSG O3 :ACCESS                    # Check your olevel
PRIVMSG O3 :GLINE *!*@host 1h reason  # Network ban
PRIVMSG O3 :REHASH                    # Reload config
```

## Docker Network

### Container IPs (irc_net: 172.29.0.0/24)
- nefarious: 172.29.0.2
- x3: 172.29.0.3
- nefarious2 (linked profile): 172.29.0.5
- keycloak: 172.29.0.10

### Profiles
```bash
docker compose up -d                              # Basic (nefarious + x3)
docker compose --profile linked up -d             # Add nefarious2
docker compose --profile linked --profile multi up -d  # Full multiserver
```

## P10 Protocol

Server-to-server protocol between Nefarious and X3. See `P10_PROTOCOL_REFERENCE.md` for comprehensive documentation.

Key points:
- Uses 2-char server numerics and 5-char user numerics (base64: A-Z, a-z, 0-9, [, ])
- Token-based commands (N=NICK, B=BURST, AC=ACCOUNT, P=PRIVMSG, etc.)
- SASL flows through P10 with subcmds: S(start), H(host), C(continue), D(done), L(login)

### P10 Extensions for IRCv3
- **MD/MDQ** - Metadata sync between IRCd and services
- **MR** - Read marker synchronization with X3 as authoritative store
- **TG** - TAGMSG for sending message tags without content
- **SASL** - Full SASL authentication flow with mechanism negotiation

### IP Encoding
IPv4: 6 base64 chars, IPv6: variable length with `_` for zero compression
```
192.0.2.1  → AAAAAA (6 chars)
::1        → _AAB (compressed)
```

## IRCv3 Feature Flags

See `FEATURE_FLAGS_CONFIG.md` for comprehensive feature flag and configuration reference.

### Nefarious Features (in features {} block)
- **Core**: `MSGID`, `SERVERTIME`
- **Capabilities**: `CAP_setname`, `CAP_batch`, `CAP_labeled_response`, `CAP_echo_message`
- **Draft Extensions**: `CAP_chathistory`, `CAP_multiline`, `CAP_metadata`, `CAP_webpush`, `CAP_read_marker`
- **Chat History**: `CHATHISTORY_MAX`, `CHATHISTORY_DB`, `CHATHISTORY_RETENTION`, `CHATHISTORY_FEDERATION`
- **Metadata**: `METADATA_DB`, `METADATA_BURST`, `METADATA_X3_TIMEOUT`
- **Compression**: `COMPRESS_THRESHOLD`, `COMPRESS_LEVEL` (requires --with-zstd)

### X3 Configuration
- **Keycloak**: `keycloak_enable`, `keycloak_url`, `keycloak_realm`, `keycloak_client_id`
- **SASL**: `sasl_enable`, `sasl_timeout`
- **Metadata TTL**: `metadata_ttl_enabled`, `metadata_default_ttl`, `metadata_immutable_keys`
- **Compression**: `metadata_compress_threshold`, `metadata_compress_level`
- **ChanServ Group Sync**: `keycloak_access_sync`, `keycloak_bidirectional_sync`

## Key Files

### Test Helpers (`tests/src/helpers/`)
- `x3-client.ts` - X3 service client with `createOperClient()`, `createX3Client()`
- `ircv3-client.ts` - Low-level IRC client with CAP negotiation
- `p10-protocol.ts` - P10 message parsing for BURST/SQUIT testing
- `multiserver.ts` - Multi-server test coordination

### Scripts
- `scripts/irc-test.sh` - Quick IRC testing from command line
- `scripts/x3-ensure-admin.sh` - Auto-create admin account on startup

### Reference Documentation
- `P10_PROTOCOL_REFERENCE.md` - Comprehensive P10 S2S protocol reference (message format, tokens, IP encoding, SASL, IRCv3 extensions)
- `FEATURE_FLAGS_CONFIG.md` - All IRCv3 feature flags, capability enums, X3 config options, Keycloak integration, metadata/compression settings
- `.claude/skills/p10-protocol.md` - P10 quick reference for Claude sessions

### Investigation/Planning Docs
- `docs/investigations/` - IRCv3 capability investigation results
- `docs/plans/` - Implementation plans

## Common Issues

### X3 Account Activation
- Email verification is enabled (`email_enabled=1` in data/x3.conf)
- x3-admin-init handles this by temporarily disabling, registering, re-enabling
- For manual activation: get cookie from `docker logs x3`, use `COOKIE <account> <cookie>`

### PING/PONG
- IRC server requires PONG response before registration completes
- All scripts must handle PING during connection

### IRC_HOST
- Tests use `IRC_HOST=localhost` to connect to exposed port
- Docker containers use `IRC_HOST=nefarious` (container name)

## Project Status

Work in progress - recently converted to git submodules. The `archive/` directory contains pre-submodule versions (can be ignored). X3 tracks a custom fork branch (`rubin-add_docker`) with Docker enhancements.
- dont build the containers yourself, it eats too much tokens watching make go by
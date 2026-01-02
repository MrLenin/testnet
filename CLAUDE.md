# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Afternet Testnet is a Docker-based IRC test environment running:
- **Nefarious IRCd** - IRC server daemon with IRCv3.2+ extensions (git submodule from evilnet/nefarious2)
- **X3 Services** - Channel/nick services with SASL/Keycloak support (git submodule from evilnet/x3)
- **Keycloak** - OAuth/OIDC identity provider for SASL authentication

Supports single-server, 2-server linked, and 4-server multi topology for testing.

## Build & Run Commands

```bash
# Basic (nefarious + x3 + keycloak)
docker compose up -d

# Linked (adds nefarious2 for 2-server testing)
docker compose --profile linked up -d

# Multi (4 servers: nefarious, nefarious2, nefarious3, nefarious4)
docker compose --profile linked --profile multi up -d

# View logs
docker compose logs -f nefarious
docker compose logs x3

# Stop all
docker compose --profile linked --profile multi down
```

**Note for Claude sessions**: Do NOT run `docker compose build` - it takes too long and eats tokens.

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
Config files are mounted directly from `data/` directory:
- `data/ircd.conf` - Primary Nefarious IRCd config
- `data/ircd2.conf`, `ircd3.conf`, `ircd4.conf` - Multi-server configs
- `data/x3.conf` - X3 services config
- `.env` / `.env.local` - Environment variables for containers

Init containers handle permissions and SSL cert generation before services start.

### Docker Structure
- Containers built on Debian 12 using GNU Autotools
- Run as non-root user (UID/GID 1234)
- Docker bridge network: `irc_net` (172.29.0.0/24)
- Named volumes for persistent data (history, metadata, x3_data, keycloak_data)

### Ports (localhost only)
| Port | Service | Description |
|------|---------|-------------|
| 6667 | nefarious | IRC plaintext |
| 6697 | nefarious | IRC SSL/TLS |
| 4497 | nefarious | IRC SSL (legacy) |
| 8443 | nefarious | WebSocket SSL |
| 9998 | nefarious | Services link (P10) |
| 6668 | nefarious2 | IRC plaintext (linked profile) |
| 6669 | nefarious3 | IRC plaintext (multi profile) |
| 6670 | nefarious4 | IRC plaintext (multi profile) |
| 8080 | keycloak | Keycloak admin UI |

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
| Container | IP | Profile | Server Name |
|-----------|-----|---------|-------------|
| nefarious | 172.29.0.2 | default | testnet.fractalrealities.net |
| x3 | 172.29.0.3 | default | x3.fractalrealities.services |
| nefarious2 | 172.29.0.5 | linked | leaf.fractalrealities.net |
| nefarious3 | 172.29.0.6 | multi | hub2.fractalrealities.net |
| nefarious4 | 172.29.0.7 | multi | leaf2.fractalrealities.net |
| keycloak | 172.29.0.10 | default | - |

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

Active development - IRCv3.2+ upgrade project with comprehensive test suite. Nefarious and X3 are git submodules tracking custom forks with enhancements:
- Nefarious: Full IRCv3.2+ support (CAP, SASL, chathistory, metadata, multiline, etc.)
- X3: Keycloak integration, LMDB caching, P10 protocol extensions

**For Claude sessions**: Don't build containers - it uses too many tokens. Use pre-built images.
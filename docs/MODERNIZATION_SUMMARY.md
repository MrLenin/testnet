# Nefarious2 & X3 Modernization Project

## The Big Picture

What started as "let's add some IRCv3 capabilities" evolved into a comprehensive modernization of the entire Afternet IRC stack. Over 100+ commits across 5 branches, we've transformed a classic IRC infrastructure into a modern, secure, identity-aware platform—while maintaining full backwards compatibility with legacy clients.

**The result:** An IRC network that speaks fluent IRCv3.2+, authenticates against Keycloak, stores data in LMDB, pushes notifications to phones, and handles WebSocket connections natively. All without breaking a single legacy mIRC client.

---

## Nefarious2 IRCd

### Security Hardening Branch

Before adding shiny new features, we needed a solid foundation. The `security-hardening` branch addressed years of accumulated technical debt:

#### Buffer Safety Overhaul
The venerable `ircd_strncpy` function had a classic off-by-one pattern scattered across the codebase. We:
- Added `ircd_strlcpy` and `ircd_strlcat` with proper BSD semantics
- Fixed every `ircd_strncpy` call site with correct `+1` size parameters
- Patched buffer underflow in WHO marks output
- Fixed off-by-one in ExtBan and `host_from_uh`

#### Cryptographic Improvements
- **Timing attack mitigation**: Password comparison no longer leaks length information through timing differences
- **Weak PRNG replacement**: Upgraded random number generation for security-sensitive operations
- **PBKDF2 support**: Added PBKDF2-SHA256/SHA512 password hashing (100,000 iterations per OWASP 2023)

#### SASL Infrastructure
- Ported `iauthd.pl` to TypeScript as `iauthd-ts`
- Added Keycloak and LDAP authentication capabilities
- Fixed crash when no specific SASL server configured
- bcrypt password support for legacy compatibility

---

### Native DNSBL & GitSync Branch

The `feature/native-dnsbl-gitsync` branch eliminated external dependencies for two critical features:

#### Native DNSBL
Previously, DNSBL lookups required external scripts or proxies. Now it's built-in:
- Zero external dependencies
- Whitelist exemption for trusted hosts
- Proper cleanup on rehash (no more duplicate server entries)
- Security hardening against injection attacks

#### GitSync (Replacing Linesync)
The old linesync used curl to fetch config files—functional but clunky. GitSync uses libgit2 directly:
- Native git operations without shelling out
- SSH key auto-generation for secure repos
- TLS certificate tag support for verification
- Remote command support for advanced workflows
- Fixed TOCTOU vulnerabilities in the process

---

### IRCv3.2+ Upgrade Branch

This is where the magic happens. The `ircv3.2-upgrade` branch implements **15+ IRCv3 specifications**, transforming Nefarious into a modern IRC server.

#### Core IRCv3 Capabilities

Every modern IRC client expects these, and now we deliver:

| Capability | What It Does |
|------------|--------------|
| `message-tags` | Arbitrary metadata on messages |
| `server-time` | Timestamps on everything |
| `msgid` | Unique IDs for every message |
| `echo-message` | Clients see their own messages reflected back |
| `batch` | Group related messages together |
| `labeled-response` | Match responses to requests |
| `account-tag` | See who's logged in at a glance |
| `setname` | Change realname without reconnecting |

#### Draft Extensions—The Interesting Stuff

Here's where Nefarious goes beyond the basics:

**Chat History** (`draft/chathistory`)
- Full LMDB backend with configurable retention (default 7 days)
- All subcommands: `LATEST`, `BEFORE`, `AFTER`, `AROUND`, `BETWEEN`, `TARGETS`
- Private message history with **opt-in consent system** (privacy-first design)
- S2S federation—query history from any server in the network
- Event playback: JOIN/PART/KICK/TOPIC/MODE included in history
- Zstd compression for storage efficiency

**Metadata** (`draft/metadata-2`)
Six phases of implementation:
1. In-memory storage with basic operations
2. Subscription system for real-time updates
3. Channel metadata support
4. Network propagation via P10 `MD` token
5. X3 integration as authoritative source
6. Rate limiting and size limits

Plus: zstd compression, per-key TTL expiry, and `/STATS` integration for monitoring.

**Multiline Messages** (`draft/multiline`)
Modern chat users expect to paste code blocks without flood kicks:
- Client batch framework with timeout handling
- Configurable max-bytes and max-lines limits
- Flood protection and rate limiting
- Graceful fallback for legacy clients (they see individual lines)

**Read Markers** (`draft/read-marker`)
Sync your read position across all your devices:
- Per-account, per-target timestamp tracking
- LMDB persistence
- Auto-send on JOIN
- Timestamp-only-increase rule (no going backwards)

**Message Redaction** (`draft/message-redaction`)
Delete that embarrassing typo:
- Time-window enforcement (can only delete recent messages)
- Role-based authorization
- P10 `RD` token for network propagation
- Audit trail for accountability

**Channel Rename** (`draft/channel-rename`)
Move `#temp-project` to `#actual-project-name` without losing anything:
- Preserves all state: members, modes, topic, bans
- Updates ChanServ registration automatically
- Graceful fallback (PART/JOIN) for non-supporting clients

**Account Registration** (`draft/account-registration`)
Register without talking to NickServ:
- `REGISTER`/`VERIFY` commands
- Email verification integration
- Keycloak/LDAP backend support
- P10 `RG`/`RR` tokens

**Pre-Away** (`draft/pre-away`)
Bouncers and mobile clients can connect already marked away:
- Set away status before registration completes
- `AWAY *` semantics for hidden connections (presence aggregation)
- Integrates with X3 for multi-device awareness

**Web Push** (`draft/webpush`)
Push notifications for disconnected clients:
- RFC 8030/8291/8292 compliant
- End-to-end encryption (AES-128-GCM)
- VAPID signing for authentication
- X3 handles all the crypto—no external daemon needed

#### Native WebSocket Support

No nginx proxy needed. Nefarious speaks WebSocket natively:
- Full RFC 6455 compliance
- Binary and text subprotocol support
- Proper frame buffering and fragmentation reassembly
- Control frames (PING/PONG/CLOSE) handled correctly
- Origin validation for security
- Works with KiwiIRC, The Lounge, and other web clients

#### SASL Hardening

Authentication got a security audit:
- Session state machine with proper transitions
- Proactive abort when services server disconnects
- `IsDead` validation before using server references
- Comprehensive error logging

#### Infrastructure Improvements

- **TCP_NODELAY**: Configurable for both C2S and S2S (reduces latency)
- **AWAY throttle**: Rate limiting to prevent abuse
- **CMocka test suite**: Unit tests for crypt, dbuf, compress, cloaking, crule, history
- **Certificate tracking**: Expiry warnings before your certs surprise you

---

## X3 Services

### Keycloak Integration Branch

The `keycloak-integration` branch transforms X3 from a standalone service bot into an identity-aware platform integrated with modern OAuth/OIDC.

#### SASL Mechanisms

X3 now supports the full spectrum:

| Mechanism | How It Works |
|-----------|--------------|
| `PLAIN` | Username/password → Keycloak validation |
| `EXTERNAL` | TLS certificate fingerprint → Keycloak attribute lookup |
| `OAUTHBEARER` | OAuth access token → Local JWT validation |
| `SCRAM-SHA-256` | Challenge-response with session tokens |

**Auto-account creation**: First OAuth login automatically creates an X3 account. No manual registration needed.

#### The Async Revolution

The old X3 blocked the entire event loop waiting for HTTP responses. A slow Keycloak meant a slow IRC network. We fixed that:

**Phase 1-2: Basic Optimization**
- TCP_NODELAY and CONNECTTIMEOUT tuning
- Connection pooling with persistent CURL handle

**Phase 3: Negative Auth Cache**
- Failed auth attempts cached for 60 seconds (MD5 hash of credentials)
- Prevents repeated hammering of Keycloak for wrong passwords

**Phase 4: Full Async HTTP**
- `curl_multi` integration with X3's ioset event loop
- Multiple SASL authentications can be in-flight simultaneously
- **The event loop never blocks on Keycloak**

**Phase 5: Local JWT Validation**
- JWKS public key caching (1-hour TTL)
- Validate OAuth tokens locally without calling Keycloak
- Fallback to introspection only for edge cases

#### Session Tokens

After successful PLAIN auth, X3 issues a session token:
- Client can use token as password for subsequent connections
- X3 detects token format (`x3tok:...`) and validates locally
- No Keycloak round-trip for reconnects
- Session versioning (`sessver:` prefix) enables bulk revocation
- Automatic revocation on password changes

**SCRAM variant** (`x3scram:tokenid`):
- Token never sent in plaintext
- Replay-resistant via nonces
- Works with WeeChat and other SCRAM-capable clients

#### Keycloak Webhook System

Real-time cache invalidation instead of waiting for TTL:
- HTTP listener on configurable port
- Shared secret authentication
- Event handlers:
  - `USER DELETE` → Removes account from cache
  - `CREDENTIAL DELETE` → Removes fingerprint from cache
  - `CREDENTIAL UPDATE/CREATE` → Logs password change
  - `USER_SESSION DELETE` → Revokes X3 session tokens

#### Bidirectional Sync

Channel access and Keycloak groups stay in sync:
- Grant ChanServ access → User added to Keycloak group
- Add user to Keycloak group → ChanServ access granted
- Fingerprint sync to Keycloak user attributes
- Cache TTL validation prevents stale data

#### LMDB Storage Backend

X3's traditional SAXDB (flat file database) works but doesn't scale well for high-frequency data. LMDB provides:

**What's in LMDB now:**
- Metadata with zstd compression
- Activity data (lastseen, last_present) - 30-day TTL
- User preferences as IRCv3 metadata - 90-day TTL
- Fingerprint storage with TTL management
- Read markers
- Session tokens

**Durability features:**
- Snapshot system with `mdb_env_copy2()` compaction
- Configurable retention (default 24 snapshots)
- JSON export for human-readable backups
- Hourly TTL purge job

#### Password Security Upgrade

Legacy X3 used MD5. We've modernized:
- **Primary**: PBKDF2-SHA256 with 100,000 iterations (OWASP 2023 minimum)
- **Supported**: bcrypt for compatibility
- **Legacy**: MD5 still accepted, automatically upgraded on login
- **Keycloak credential import**: Hash sent to Keycloak, never plaintext password

#### Presence Aggregation

Multi-device support done right:
- Track all connections per account
- Per-connection away state
- Aggregated presence:
  - If ANY connection is present → user appears present
  - If ALL connections use `AWAY *` → user appears away
- Change detection to minimize network traffic

#### P10 Protocol Extensions

New tokens for IRCv3 features:
- `TM` - TAGMSG (message tags without content)
- `ML` - Multiline batch propagation
- `RG`/`RR` - Account registration
- `MR` - Read marker sync
- `MD` - Metadata with compression flag
- Chathistory federation response handler
- Proactive metadata push to Nefarious for online users

#### Code Quality Audit

Years of C code accumulate issues. We fixed:

**Critical:**
- Buffer overflow in alloc-x3.c (bounds check added)
- malloc NULL checks in keycloak.c and nickserv.c
- realloc memory leak
- Timer scheduling bug: handles/nicks/metadata expiry timers were never scheduled (moved to `nickserv_conf_read()`)
- NULL language pointer crash in saxdb_write

**Build system:**
- glibc C23 compatibility (`-D__USE_ISOC23=0`)
- `-Wall -Wextra -Werror` warnings enabled
- Static analysis integration (cppcheck, scan-build)
- SASL callback return types fixed (void → int)

---

### SAXDB Optional Branch (In Progress)

The `saxdb-optional` branch is actively migrating all remaining X3 data from SAXDB flat files to LMDB. When complete, new deployments can start with `saxdb_enabled=0`.

**Migration scope:**
- NickServ: accounts, nicks, masks, ignores, cookies
- ChanServ: channels, users, bans, notes
- OpServ: glines, shuns, trusted hosts, alerts
- Supporting modules: Global, ModCmd, MemoServ

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENTS                                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────────┐ │
│  │  mIRC   │  │ WeeChat │  │HexChat  │  │ KiwiIRC/The Lounge  │ │
│  │ (legacy)│  │ (SCRAM) │  │ (CAP)   │  │    (WebSocket)      │ │
│  └────┬────┘  └────┬────┘  └────┬────┘  └──────────┬──────────┘ │
│       │            │            │                   │            │
└───────┼────────────┼────────────┼───────────────────┼────────────┘
        │            │            │                   │
        └────────────┴─────┬──────┴───────────────────┘
                           │
                    IRCv3.2+ / WebSocket
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                    NEFARIOUS IRCd                                │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ CAP Negotiation │ SASL │ Message Tags │ Batch │ WebSocket  │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │        Chathistory (LMDB)  │  Metadata (LMDB cache)        │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  Native DNSBL  │  GitSync (libgit2)  │  Certificate Track  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
└──────────────────────────────┼───────────────────────────────────┘
                               │
                          P10 Protocol
                    (MD, MR, TM, ML, RG/RR)
                               │
┌──────────────────────────────┼───────────────────────────────────┐
│                        X3 SERVICES                               │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │   AuthServ   │   ChanServ   │   OpServ   │   MemoServ     │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │     SASL Engine (PLAIN/EXTERNAL/OAUTHBEARER/SCRAM)        │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  Async HTTP (curl_multi)  │  Local JWT  │  Session Tokens │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │  Presence Aggregation  │  Webhook Listener  │  Web Push   │ │
│  └─────────────┬──────────────────────────────┬───────────────┘ │
│                │                              │                  │
└────────────────┼──────────────────────────────┼──────────────────┘
                 │                              │
        ┌────────┴────────┐            ┌───────┴────────┐
        │                 │            │                │
        ▼                 ▼            ▼                ▼
┌───────────────┐  ┌─────────────┐  ┌─────────────────────────────┐
│     LMDB      │  │   SAXDB     │  │         KEYCLOAK            │
│  ┌─────────┐  │  │  (legacy)   │  │  ┌───────────────────────┐  │
│  │metadata │  │  │             │  │  │   OAuth/OIDC/SAML     │  │
│  │history  │  │  │  accounts   │  │  ├───────────────────────┤  │
│  │markers  │  │  │  channels   │  │  │  User Attributes      │  │
│  │sessions │  │  │  bans       │  │  │  - fingerprints       │  │
│  │activity │  │  │  glines     │  │  │  - x3_opserv_level    │  │
│  │fingerpr │  │  │             │  │  ├───────────────────────┤  │
│  └─────────┘  │  │             │  │  │  Groups (→ ChanServ)  │  │
│               │  │             │  │  │  Webhooks (→ X3)      │  │
└───────────────┘  └─────────────┘  └─────────────────────────────┘
```

---

## By The Numbers

| Metric | Before | After |
|--------|--------|-------|
| IRCv3 Specifications | Basic CAP only | 15+ including drafts |
| SASL Mechanisms | PLAIN | PLAIN, EXTERNAL, OAUTHBEARER, SCRAM-SHA-256 |
| Password Hashing | MD5 | PBKDF2-SHA256 (100k iterations) |
| Auth Blocking | Synchronous (entire event loop) | Fully async, concurrent |
| Message History | None | 7-day LMDB with federation |
| WebSocket | External proxy required | Native RFC 6455 |
| Unit Tests | None | CMocka suite |
| DNSBL | External script | Native |
| Config Sync | curl-based linesync | Native libgit2 |
| Identity Provider | Local only | Keycloak OAuth/OIDC |
| Multi-device | Single connection | Presence aggregation |
| Session Management | None | Tokens with revocation |

---

## What's Still Cooking

### In Progress
- **SAXDB→LMDB migration**: Moving all remaining data to LMDB for `saxdb_enabled=0` deployments

### Deferred (Not Currently Needed)
- **Multi-X3 with Redis**: Active/passive failover—single X3 instance is sufficient for current scale
- **MFA for SASL EXTERNAL**: Certificate + second factor

### Tools & Polish
- Password hash migration analysis scripts
- Additional test coverage for edge cases

---

## Branch Summary

| Branch | Repository | Focus |
|--------|------------|-------|
| `security-hardening` | Nefarious | Buffer safety, timing attacks, PRNG |
| `feature/native-dnsbl-gitsync` | Nefarious | Native DNSBL, libgit2 config sync |
| `ircv3.2-upgrade` | Nefarious | Full IRCv3.2+ implementation |
| `keycloak-integration` | X3 | OAuth/OIDC, async HTTP, LMDB, sessions |
| `saxdb-optional` | X3 | Complete LMDB migration (in progress) |

---

## The Bottom Line

This isn't just an upgrade—it's a transformation. Users get modern features like message history, read markers, and push notifications. Operators get Keycloak integration, proper security, and observable infrastructure. Developers get a codebase with unit tests, static analysis, and sensible architecture.

And legacy clients? They still work fine. The IRC protocol's greatest strength is backwards compatibility, and we've preserved it while building for the future.

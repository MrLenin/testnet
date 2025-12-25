# IRCv3.2+ Upgrade Project Status

**Reference Commits:**
- Nefarious: `2a0aaba` (ircv3.2-upgrade branch)
- X3: `ea1b586` (keycloak-integration branch)

> **Note:** The `ircv3.2-upgrade` branch contains all IRCv3 features including WebSocket and Presence aggregation.

---

## Quick Navigation

| Document | Purpose |
|----------|---------|
| [P10_PROTOCOL_REFERENCE.md](P10_PROTOCOL_REFERENCE.md) | Complete P10 protocol with all tokens |
| [FEATURE_FLAGS_CONFIG.md](FEATURE_FLAGS_CONFIG.md) | All config options for Nefarious and X3 |
| [X3_KEYCLOAK_INTEGRATION.md](X3_KEYCLOAK_INTEGRATION.md) | Keycloak backend integration |
| [docs/investigations/](docs/investigations/) | Feature investigation documents |
| [docs/plans/](docs/plans/) | Implementation planning documents |

---

## Implementation Status

### Nefarious IRCd Capabilities

| Capability | Status | Feature Flag | Description |
|------------|--------|--------------|-------------|
| `multi-prefix` | Done | `CAP_multi_prefix` | Multiple user modes in NAMES |
| `userhost-in-names` | Done | `CAP_userhost_in_names` | User@host in NAMES |
| `extended-join` | Done | `CAP_extended_join` | Account in JOIN |
| `away-notify` | Done | `CAP_away_notify` | AWAY status changes |
| `account-notify` | Done | `CAP_account_notify` | Account changes |
| `sasl` | Done | `CAP_sasl` | SASL authentication |
| `cap-notify` | Done | - | CAP change notifications |
| `server-time` | Done | `FEAT_SERVERTIME` | Message timestamps |
| `echo-message` | Done | `CAP_echo_message` | Echo sent messages |
| `account-tag` | Done | `CAP_account_tag` | Account tag on messages |
| `chghost` | Done | `CAP_chghost` | Host change notifications |
| `invite-notify` | Done | `CAP_invite_notify` | Invite notifications |
| `labeled-response` | Done | `CAP_labeled_response` | Command correlation |
| `batch` | Done | `CAP_batch` | Message batching |
| `setname` | Done | `CAP_setname` | Realname changes |
| `standard-replies` | Done | `CAP_standard_replies` | Standard reply format |
| `message-tags` | Done | `CAP_message_tags` | Client message tags |

### Draft Capabilities

| Capability | Status | Feature Flag | Description |
|------------|--------|--------------|-------------|
| `draft/no-implicit-names` | Done | `CAP_no_implicit_names` | Opt-out of auto NAMES |
| `draft/extended-isupport` | Done | `CAP_extended_isupport` | ISUPPORT via CAP |
| `draft/pre-away` | Done | `CAP_pre_away` | Away before registration |
| `draft/multiline` | Done | `CAP_multiline` | Multi-line messages |
| `draft/chathistory` | Done | `CAP_chathistory` | Message history |
| `draft/event-playback` | Done | `CAP_event_playback` | Event replay |
| `draft/message-redaction` | Done | `CAP_message_redaction` | Message deletion |
| `draft/account-registration` | Done | `CAP_account_registration` | In-band registration |
| `draft/read-marker` | Done | `CAP_read_marker` | Read position sync |
| `draft/channel-rename` | Done | `CAP_channel_rename` | Channel renaming |
| `draft/metadata-2` | Done | `CAP_metadata` | User/channel metadata |
| `draft/webpush` | Done | `CAP_webpush` | Push notifications |

---

## P10 Protocol Tokens

### Core Tokens (Standard)

| Token | Command | Description |
|-------|---------|-------------|
| `G` | PING | Keepalive |
| `Z` | PONG | Ping response |
| `N` | NICK | User intro/nick change |
| `Q` | QUIT | User disconnect |
| `B` | BURST | Channel state |
| `EB` | END_OF_BURST | Burst complete |
| `EA` | EOB_ACK | Burst acknowledged |
| `J` | JOIN | Channel join |
| `L` | PART | Channel part |
| `K` | KICK | Channel kick |
| `M` | MODE | Mode change |
| `P` | PRIVMSG | Message |
| `O` | NOTICE | Notice |
| `T` | TOPIC | Topic change |
| `A` | AWAY | Away status |
| `AC` | ACCOUNT | Account state |
| `FA` | FAKEHOST | Virtual host |
| `SA` | SASL | SASL auth |

### IRCv3 Extension Tokens

| Token | Command | Direction | Description |
|-------|---------|-----------|-------------|
| `SE` | SETNAME | Both | Realname change |
| `TM` | TAGMSG | Both | Tag-only message |
| `BT` | BATCH | Both | Batch coordination |
| `CH` | CHATHISTORY | Both | History requests |
| `RD` | REDACT | Both | Message redaction |
| `RG` | REGISTER | Nef→X3 | Account registration |
| `VF` | VERIFY | Nef→X3 | Account verification |
| `RR` | REGREPLY | X3→Nef | Registration result |
| `MR` | MARKREAD | Both | Read marker sync |
| `RN` | RENAME | Both | Channel rename |
| `MD` | METADATA | Both | Metadata set/get |
| `MDQ` | METADATAQUERY | Nef→X3 | Metadata query |
| `WP` | WEBPUSH | Both | Push notifications |

---

## X3 Services Features

### Storage Backends

| Backend | Status | Purpose |
|---------|--------|---------|
| SAXDB | Active | Bulk data (accounts, channels) |
| LMDB | Active | High-frequency data (metadata, read markers) |
| Keycloak | Optional | Identity provider, metadata persistence |
| Redis | Planned | Multi-instance pub/sub sync (see [X3_STORAGE_BACKEND_PLAN.md](docs/plans/X3_STORAGE_BACKEND_PLAN.md)) |

### LMDB Storage (x3_lmdb.c)

| Function Category | Operations |
|-------------------|------------|
| Account Metadata | get, set, delete, list, clear, get_ex, set_ex |
| Channel Metadata | get, set, delete, list, clear, get_ex, set_ex |
| Channel Access | get, set, delete, list, list_account, clear |
| Utilities | init, shutdown, sync, stats, purge_expired |

### Keycloak Integration (keycloak.c)

| Feature | Status |
|---------|--------|
| User authentication | Done |
| User attributes (metadata) | Done |
| Group sync (channel access) | Done |
| Hierarchical groups | Done |
| OAuth2/OIDC | Done |

---

## Configuration Reference

### Nefarious Features (ircd.conf)

```
features {
    # Core
    "MSGID" = "TRUE";
    "SERVERTIME" = "TRUE";

    # Multiline limits
    "MULTILINE_MAX_BYTES" = "4096";
    "MULTILINE_MAX_LINES" = "100";

    # Chat history
    "CHATHISTORY_MAX" = "100";
    "CHATHISTORY_DB" = "history";
    "CHATHISTORY_RETENTION" = "7";
    "CHATHISTORY_PRIVATE" = "FALSE";

    # Metadata caching
    "METADATA_CACHE_ENABLED" = "TRUE";
    "METADATA_X3_TIMEOUT" = "60";
    "METADATA_QUEUE_SIZE" = "1000";
    "METADATA_BURST" = "TRUE";

    # Presence aggregation
    "PRESENCE_AGGREGATION" = "FALSE";
    "AWAY_STAR_MSG" = "Away";
};
```

### X3 Configuration (x3.conf)

```
"nickserv" {
    # Keycloak
    "keycloak_enable" = "1";
    "keycloak_url" = "https://keycloak.example.com";
    "keycloak_realm" = "irc";
    "keycloak_client_id" = "x3-services";
    "keycloak_client_secret" = "secret";

    # Metadata TTL
    "metadata_ttl_enabled" = "1";
    "metadata_default_ttl" = "2592000";
    "metadata_purge_frequency" = "3600";
    "metadata_immutable_keys" = "avatar pronouns bot homepage";

    # Compression
    "metadata_compress_threshold" = "256";
    "metadata_compress_level" = "3";
};

"chanserv" {
    # Keycloak group sync
    "keycloak_access_sync" = "1";
    "keycloak_hierarchical_groups" = "1";
    "keycloak_group_prefix" = "irc-channels";
    "keycloak_sync_frequency" = "3600";

    # Channel metadata TTL
    "channel_metadata_ttl_enabled" = "1";
    "channel_metadata_default_ttl" = "2592000";
    "channel_immutable_keys" = "url website rules description";
};

"uplinks" {
    "hub" {
        "ssl" = "1";
        "ssl_verify" = "0";
    };
};
```

---

## Build Requirements

### Nefarious

| Option | Library | Purpose |
|--------|---------|---------|
| `--with-ssl` | OpenSSL | TLS/SASL |
| `--with-geoip` | MaxMind | Location data |
| `--enable-websocket` | - | WebSocket support |

### X3

| Option | Library | Purpose |
|--------|---------|---------|
| `--with-ssl` | OpenSSL | TLS connections |
| `--with-lmdb` | liblmdb | Metadata cache |
| `--with-keycloak` | libcurl, libjansson | Identity provider |
| `--with-zstd` | libzstd | Value compression |

---

## Documentation Index

### Investigation Documents

| File | Feature |
|------|---------|
| [ACCOUNT_REGISTRATION_INVESTIGATION.md](docs/investigations/ACCOUNT_REGISTRATION_INVESTIGATION.md) | In-band account registration |
| [CHANNEL_RENAME_INVESTIGATION.md](docs/investigations/CHANNEL_RENAME_INVESTIGATION.md) | Channel rename capability |
| [CHATHISTORY_INVESTIGATION.md](docs/investigations/CHATHISTORY_INVESTIGATION.md) | Message history retrieval |
| [CLIENT_BATCH_INVESTIGATION.md](docs/investigations/CLIENT_BATCH_INVESTIGATION.md) | Message batching |
| [CLIENT_TAGS_INVESTIGATION.md](docs/investigations/CLIENT_TAGS_INVESTIGATION.md) | Message tags |
| [EVENT_PLAYBACK_INVESTIGATION.md](docs/investigations/EVENT_PLAYBACK_INVESTIGATION.md) | Event history playback |
| [EXTENDED_ISUPPORT_INVESTIGATION.md](docs/investigations/EXTENDED_ISUPPORT_INVESTIGATION.md) | Extended ISUPPORT |
| [MESSAGE_REDACTION_INVESTIGATION.md](docs/investigations/MESSAGE_REDACTION_INVESTIGATION.md) | Message deletion |
| [METADATA_INVESTIGATION.md](docs/investigations/METADATA_INVESTIGATION.md) | User/channel metadata |
| [MULTILINE_INVESTIGATION.md](docs/investigations/MULTILINE_INVESTIGATION.md) | Multi-line messages |
| [NO_IMPLICIT_NAMES_INVESTIGATION.md](docs/investigations/NO_IMPLICIT_NAMES_INVESTIGATION.md) | Opt-out NAMES |
| [PRE_AWAY_INVESTIGATION.md](docs/investigations/PRE_AWAY_INVESTIGATION.md) | Pre-registration AWAY |
| [READ_MARKER_INVESTIGATION.md](docs/investigations/READ_MARKER_INVESTIGATION.md) | Read position sync |
| [WEBPUSH_INVESTIGATION.md](docs/investigations/WEBPUSH_INVESTIGATION.md) | Push notifications |
| [WEBSOCKET_INVESTIGATION.md](docs/investigations/WEBSOCKET_INVESTIGATION.md) | WebSocket transport |

### Planning Documents

| File | Purpose |
|------|---------|
| [NEFARIOUS_IRCV3_UPGRADE_PLAN.md](docs/plans/NEFARIOUS_IRCV3_UPGRADE_PLAN.md) | Master upgrade plan |
| [METADATA_ENHANCEMENT_PLAN.md](docs/plans/METADATA_ENHANCEMENT_PLAN.md) | Metadata system design |
| [PRE_AWAY_AGGREGATION_PLAN.md](docs/plans/PRE_AWAY_AGGREGATION_PLAN.md) | Presence aggregation design |
| [X3_STORAGE_BACKEND_PLAN.md](docs/plans/X3_STORAGE_BACKEND_PLAN.md) | LMDB + optional Redis storage design |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       IRC Clients                           │
│              (IRCv3.2+ capable, CAP negotiation)            │
└───────────────────────────┬─────────────────────────────────┘
                            │ IRC Protocol + IRCv3 extensions
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     Nefarious IRCd                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │  CAP Negotiation │  │ Message Tags    │  │  LMDB Cache │  │
│  │  (28 capabilities)│  │ (time, msgid)   │  │  (metadata) │  │
│  └─────────────────┘  └─────────────────┘  └─────────────┘  │
└───────────────────────────┬─────────────────────────────────┘
                            │ P10 Protocol + Extension Tokens
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                       X3 Services                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │    NickServ     │  │    ChanServ     │  │   OpServ    │  │
│  │  (SASL, Accts)  │  │ (Channels, ACL) │  │ (Admin)     │  │
│  └────────┬────────┘  └────────┬────────┘  └─────────────┘  │
│           └────────────┬───────┘                            │
│                        ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                   Storage Layer                          ││
│  │  ┌──────────┐  ┌──────────┐  ┌─────────────────────────┐││
│  │  │  SAXDB   │  │   LMDB   │  │       Keycloak          │││
│  │  │ (bulk)   │  │ (cache)  │  │ (identity, attributes)  │││
│  │  └──────────┘  └──────────┘  └─────────────────────────┘││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

---

## Future Work

| Feature | Priority | Status | Description | Plan |
|---------|----------|--------|-------------|------|
| Redis pub/sub sync | Optional | Planned | Multi-X3 instance real-time metadata sync (requires X3 architecture changes) | [X3_STORAGE_BACKEND_PLAN.md](docs/plans/X3_STORAGE_BACKEND_PLAN.md#optional-phase-7-redis-pubsub-layer) |

> **All other features are implemented.** WebSocket transport and Presence aggregation are complete on the `ircv3.2-upgrade` branch.

---

## Version History

| Date | Changes |
|------|---------|
| December 2024 | Initial IRCv3.2+ implementation |
| December 2024 | Added all draft capabilities |
| December 2024 | Keycloak integration complete |
| December 2024 | LMDB storage layer added |
| December 2024 | SSL/TLS S2S support |
| December 2024 | zstd compression support |

---

*Generated from reference commits on 2024-12-25*

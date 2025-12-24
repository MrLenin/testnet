# IRCv3 Chathistory Extension Investigation

## Status: IMPLEMENTED (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/chathistory

**Capability Names**:
- `draft/chathistory` - Core chathistory functionality ✅ Implemented
- `draft/event-playback` - Optional: Replay non-PRIVMSG/NOTICE events (JOIN, PART, etc.)

**Storage Backend**: LMDB (Lightning Memory-Mapped Database)

---

## Implementation Summary

### Files Added/Modified

| File | Description |
|------|-------------|
| `include/history.h` | Data structures and API declarations |
| `ircd/history.c` | LMDB-based storage implementation |
| `ircd/m_chathistory.c` | CHATHISTORY command handler |
| `include/capab.h` | Added CAP_DRAFT_CHATHISTORY, CAP_DRAFT_EVENTPLAYBACK |
| `ircd/m_cap.c` | Registered draft/chathistory capability |
| `include/ircd_features.h` | Added FEAT_CAP_draft_chathistory, FEAT_CHATHISTORY_* |
| `ircd/ircd_features.c` | Feature registration |
| `ircd/s_user.c` | ISUPPORT tokens (CHATHISTORY, MSGREFTYPES) |
| `ircd/ircd_relay.c` | Message capture hooks |
| `ircd/ircd.c` | History initialization |
| `ircd/parse.c` | CHATHISTORY command registration |
| `include/msg.h` | MSG_CHATHISTORY, TOK_CHATHISTORY |
| `include/handlers.h` | m_chathistory declaration |
| `configure.in` | LMDB library detection |
| `ircd/Makefile.in` | Build rules |

### Configuration

```
features {
    "CAP_draft_chathistory" = "TRUE";     /* Enable capability */
    "CHATHISTORY_MAX" = "100";            /* Max messages per query */
    "CHATHISTORY_DB" = "history";         /* Database directory */
    "CHATHISTORY_RETENTION" = "7";        /* Days to keep (TODO: implement purge) */
    "CHATHISTORY_PRIVATE" = "FALSE";      /* Enable DM history (privacy option) */
    "CAP_draft_event_playback" = "FALSE"; /* Event playback (not yet implemented) */
};
```

### Build Requirements

```bash
# Debian/Ubuntu
apt-get install liblmdb-dev

# Configure
./configure --with-lmdb

# Or disable
./configure --disable-lmdb
```

---

## Specification Overview

The chathistory extension allows clients to request message history from the server. This enables:
- Retrieving missed messages on reconnect
- Scrollback for bouncers
- Syncing history across multiple client connections
- Persistent conversation history

---

## CHATHISTORY Command Syntax

### Core Subcommands

| Subcommand | Syntax | Description |
|------------|--------|-------------|
| `BEFORE` | `CHATHISTORY BEFORE <target> <reference> <limit>` | Messages before a point |
| `AFTER` | `CHATHISTORY AFTER <target> <reference> <limit>` | Messages after a point |
| `LATEST` | `CHATHISTORY LATEST <target> <reference \| *> <limit>` | Most recent messages |
| `AROUND` | `CHATHISTORY AROUND <target> <reference> <limit>` | Messages around a point |
| `BETWEEN` | `CHATHISTORY BETWEEN <target> <ref1> <ref2> <limit>` | Messages between points |
| `TARGETS` | `CHATHISTORY TARGETS <timestamp> <timestamp> <limit>` | Channels/users with history |

### Message Reference Formats

| Format | Example | Description |
|--------|---------|-------------|
| `timestamp=` | `timestamp=2025-12-23T12:30:00.000Z` | ISO 8601 UTC timestamp |
| `msgid=` | `msgid=AB-1703334400-12345` | Unique message ID |
| `*` | `*` | Wildcard (only for LATEST) |

### ISUPPORT Tokens

| Token | Example Value | Description |
|-------|---------------|-------------|
| `CHATHISTORY` | `100` | Max messages per request (0=unlimited) |
| `MSGREFTYPES` | `timestamp,msgid` | Supported reference types in preference order |

---

## Error Responses (Standard Replies)

| Code | Condition | Example |
|------|-----------|---------|
| `INVALID_PARAMS` | Malformed command | `FAIL CHATHISTORY INVALID_PARAMS ...` |
| `INVALID_TARGET` | No access/doesn't exist | `FAIL CHATHISTORY INVALID_TARGET #channel :Not found` |
| `MESSAGE_ERROR` | Retrieval failure | `FAIL CHATHISTORY MESSAGE_ERROR ...` |
| `INVALID_MSGREFTYPE` | Unsupported reference | `FAIL CHATHISTORY INVALID_MSGREFTYPE msgid= :Not supported` |

---

## Required Capabilities (Dependencies)

| Capability | Status in Nefarious | Notes |
|------------|---------------------|-------|
| `batch` | Complete | CAP_BATCH implemented |
| `server-time` | Complete | CAP_SERVERTIME implemented |
| `message-tags` | Complete | Full tag infrastructure |
| `msgid` tag | Complete | FEAT_MSGID, generate_msgid() |
| `standard-replies` | Complete | send_fail/warn/note() |

**All dependencies are already implemented!**

---

## Infrastructure Assessment

### Already Implemented

| Component | Location | Details |
|-----------|----------|---------|
| Batch support | `m_batch.c` | `chathistory` batch type can be added |
| Message IDs | `send.c:216-229` | Format: `<numeric>-<ts>-<counter>` |
| Server-time | `send.c:74-86` | ISO 8601 UTC timestamps |
| Tag formatting | `send.c:123-191` | `format_message_tags_ex()` |
| Standard replies | `send.c:2180-2225` | FAIL/WARN/NOTE functions |

### Not Implemented

| Component | Effort | Description |
|-----------|--------|-------------|
| Message storage | High | SQL database for messages with msgid+timestamp |
| CHATHISTORY command | Medium | New command handler in Nefarious |
| History query P10 | Medium | New P10 command for X3 to query/serve history |
| Message indexing | Included | SQL handles this natively |
| Event storage | Medium | For draft/event-playback |

---

## Architecture Decision: Storage Backend

### Option A: X3 SAXDB - NOT RECOMMENDED

**Why Not**:
- Text-based key-value format
- No indexing capability
- Full database rewrite on each save
- Not designed for time-series queries

### Option B: SQLite (Recommended for Single-Server)

**Pros**:
- Embedded, no external process
- ACID compliant
- Excellent indexing (timestamp, msgid, channel)
- Efficient range queries
- Well-tested C API

**Cons**:
- Per-server storage (not centralized)
- File locking considerations

**Schema**:
```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msgid TEXT UNIQUE NOT NULL,
    timestamp TEXT NOT NULL,  -- ISO 8601
    target TEXT NOT NULL,     -- #channel or nick
    sender TEXT NOT NULL,     -- nick!user@host
    account TEXT,             -- sender's account (nullable)
    type TEXT NOT NULL,       -- PRIVMSG, NOTICE, JOIN, etc.
    content TEXT,

    -- Indexes for efficient queries
    INDEX idx_target_time (target, timestamp),
    INDEX idx_msgid (msgid)
);

CREATE TABLE targets (
    target TEXT PRIMARY KEY,
    last_message_time TEXT NOT NULL,
    message_count INTEGER DEFAULT 0
);
```

### Option C: PostgreSQL (Recommended for Multi-Server)

**Pros**:
- Centralized storage
- Network accessible
- Better for large deployments
- Advanced features (JSONB, full-text search)

**Cons**:
- External dependency
- Network latency
- More complex deployment

### Option D: Hybrid (X3 Coordinates, SQL Stores)

**Approach**:
- X3 manages the SQL database
- Nefarious queries X3 via P10
- X3 queries SQL and returns results

**Pros**:
- Centralized control
- Account-aware access control
- Single point of configuration

**Cons**:
- P10 round-trip latency
- More complex protocol

---

## Recommended Architecture

### For Single-Server / Small Network: SQLite in Nefarious

```
Client <--IRC--> Nefarious <--SQLite--> messages.db
```

- Nefarious handles CHATHISTORY directly
- SQLite database in data directory
- No P10 changes needed
- Simplest implementation

### For Multi-Server Network: X3 + PostgreSQL

```
Client <--IRC--> Nefarious <--P10--> X3 <--SQL--> PostgreSQL
                                      |
                 Nefarious <--P10-----+
```

- X3 owns the message database
- New P10 token for history queries
- Centralized storage and access control

---

## Implementation Phases (SQLite Approach)

### Phase 1: SQLite Integration in Nefarious

**Goal**: Add SQLite database for message storage

**New files**:
- `nefarious/ircd/m_history.c` - History storage and retrieval
- `nefarious/include/history.h` - Data structures and API

**Dependencies**:
- libsqlite3-dev (build dependency)
- configure.in changes for --with-history

**API**:
```c
int history_init(const char *dbpath);
void history_shutdown(void);
int history_store_message(const char *msgid, const char *timestamp,
                          const char *target, const char *sender,
                          const char *account, const char *type,
                          const char *content);
int history_query_before(const char *target, const char *ref,
                         int limit, struct HistoryMessage **out);
int history_query_after(const char *target, const char *ref,
                        int limit, struct HistoryMessage **out);
int history_query_latest(const char *target, const char *ref,
                         int limit, struct HistoryMessage **out);
int history_query_around(const char *target, const char *ref,
                         int limit, struct HistoryMessage **out);
int history_query_between(const char *target, const char *ref1,
                          const char *ref2, int limit,
                          struct HistoryMessage **out);
int history_query_targets(const char *ts1, const char *ts2,
                          int limit, struct HistoryTarget **out);
```

### Phase 2: Message Capture

**Goal**: Store messages as they flow through Nefarious

**Integration points**:
- `ircd_relay.c` - Hook into relay_channel_message(), relay_private_message()
- After message is sent, call history_store_message()

**Capture flow**:
```
Client sends PRIVMSG #channel :hello
  -> relay_channel_message()
     -> send message to channel members
     -> history_store_message(msgid, time, "#channel", sender, account, "PRIVMSG", "hello")
```

### Phase 3: CHATHISTORY Command Handler

**Goal**: Parse and execute CHATHISTORY commands

**New file**: `nefarious/ircd/m_chathistory.c`

**Registration**: Add to parse.c msgtab

**Handler flow**:
```c
int m_chathistory(struct Client *cptr, struct Client *sptr, int parc, char *parv[])
{
    // 1. Validate client has draft/chathistory capability
    // 2. Parse subcommand (BEFORE, AFTER, LATEST, etc.)
    // 3. Validate target (channel exists, user has access)
    // 4. Parse reference (timestamp= or msgid=)
    // 5. Query history database
    // 6. Send batch response with messages
}
```

### Phase 4: Batch Response Generation

**Goal**: Format history results as IRCv3 batch

**Response format**:
```
:server BATCH +abc123 chathistory #channel
@time=2025-12-23T12:00:00.000Z;msgid=AB-123-1 :nick!u@h PRIVMSG #channel :msg1
@time=2025-12-23T12:01:00.000Z;msgid=AB-123-2 :nick!u@h PRIVMSG #channel :msg2
:server BATCH -abc123
```

### Phase 5: Capability Advertisement

**Goal**: Advertise draft/chathistory to clients

**Changes**:
- Add CAP_CHATHISTORY to capab.h
- Add FEAT_CAP_chathistory to ircd_features.h
- Update m_cap.c to advertise capability
- Add CHATHISTORY and MSGREFTYPES to ISUPPORT

### Phase 6: Event Playback (Optional)

**Goal**: Store and replay non-message events

**Events to capture**:
- JOIN, PART, QUIT
- MODE changes
- TOPIC changes
- KICK

**Capability**: `draft/event-playback`

---

## Configuration Options

### Nefarious (ircd.conf):
```
features {
    "CAP_chathistory" = "TRUE";
    "CHATHISTORY_MAX" = "100";       // Max messages per query
    "CHATHISTORY_DB" = "history.db"; // SQLite database path
    "CHATHISTORY_RETENTION" = "7";   // Days to keep messages
    "CHATHISTORY_EVENTS" = "FALSE";  // Enable event-playback
};
```

---

## Access Control Considerations

1. **Channel history**: Only members can query (or those with invite?)
2. **Private messages**: Only participants can query
3. **Deleted channels**: History retained? For how long?
4. **Banned users**: Can they query history from when they were members?
5. **Services integration**: Should X3 ChanServ control history access?

---

## Effort Estimate

| Phase | Effort | Description |
|-------|--------|-------------|
| 1: SQLite Integration | High (24-32 hours) | Database setup, schema, API |
| 2: Message Capture | Medium (8-16 hours) | Hook into relay functions |
| 3: CHATHISTORY Command | Medium (16-24 hours) | Parse, validate, execute |
| 4: Batch Response | Low (8-12 hours) | Format and send results |
| 5: Capability Advertisement | Low (4-8 hours) | CAP, ISUPPORT |
| 6: Event Playback | Medium (16-24 hours) | Optional extension |

**Total**: 76-116 hours (SQLite approach, without event playback)

---

## Testing Strategy

1. **Unit tests**: SQLite operations (store, query, delete)
2. **Integration tests**: Full CHATHISTORY flow
3. **Client tests**: IRCCloud, The Lounge, gamja
4. **Performance tests**: 100k+ messages, query latency
5. **Retention tests**: Verify old messages are purged

---

## Clients with Chathistory Support

| Client | Support Level |
|--------|---------------|
| IRCCloud | Full |
| The Lounge | Full |
| WeeChat | Via plugin |
| Kiwi IRC | Full |
| gamja | Full |
| Goguma | Full |
| Halloy | Full |

---

## Key Decisions Needed

1. **Storage location**: Nefarious (SQLite) vs X3 (PostgreSQL)?
2. **Multi-server**: How to handle? Replicate? Centralize?
3. **Retention policy**: Time-based, count-based, or both?
4. **Access control**: Who can query what?
5. **Event playback**: Implement now or defer?
6. **Private messages**: Store DM history? Privacy implications?

---

## References

- **Chathistory Spec**: https://ircv3.net/specs/extensions/chathistory
- **Batch Spec**: https://ircv3.net/specs/extensions/batch
- **Event Playback**: https://ircv3.net/specs/extensions/chathistory#eventplayback
- **SQLite C API**: https://sqlite.org/c3ref/intro.html

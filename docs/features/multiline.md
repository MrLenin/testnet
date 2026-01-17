# Multiline Messages

Implementation of `draft/multiline` IRCv3 extension in Nefarious IRCd.

## Overview

Multiline messages allow sending multiple lines as a single atomic unit using the BATCH mechanism. This enables proper multi-line pastes, code blocks, and formatted text without flood protection interference.

## Architecture

```
Client ─► BATCH +id multiline #channel
       ─► @batch=id PRIVMSG #channel :Line 1
       ─► @batch=id PRIVMSG #channel :Line 2
       ─► BATCH -id
                │
                ▼
        ┌───────────────┐
        │   Nefarious   │
        │ - Accumulate  │
        │ - Validate    │
        │ - Fan out     │
        └───────┬───────┘
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
Draft ML    Legacy      S2S ML
Clients     Clients     Servers
(batch)     (fallback)  (token)
```

## Feature Flags

### Core Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_CAP_multiline` | TRUE | Enable `draft/multiline` capability |
| `FEAT_MULTILINE_MAX_BYTES` | 4096 | Max total bytes in batch |
| `FEAT_MULTILINE_MAX_LINES` | 24 | Max lines in batch |

### Flood Protection

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_MULTILINE_LAG_DISCOUNT` | 50 | % lag for DMs (0-100) |
| `FEAT_MULTILINE_CHANNEL_LAG_DISCOUNT` | 75 | % lag for channels |
| `FEAT_MULTILINE_MAX_LAG` | 30 | Max accumulated lag (seconds) |
| `FEAT_MULTILINE_RECIPIENT_DISCOUNT` | TRUE | Extra discount when all recipients support multiline |
| `FEAT_BATCH_RATE_LIMIT` | 10 | Max batches/minute (0 = disabled) |
| `FEAT_CLIENT_BATCH_TIMEOUT` | 30 | Incomplete batch timeout |

### Echo Protection

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_MULTILINE_ECHO_PROTECT` | TRUE | Prevent echo amplification |
| `FEAT_MULTILINE_ECHO_MAX_FACTOR` | 2 | Max output/input ratio |

### Legacy Fallback

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_MULTILINE_LEGACY_THRESHOLD` | 3 | Lines to trigger fallback |
| `FEAT_MULTILINE_LEGACY_MAX_LINES` | 5 | Max preview lines |
| `FEAT_MULTILINE_FALLBACK_NOTIFY` | TRUE | Notify about truncation |

### S2S Storage

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_MULTILINE_STORAGE_ENABLED` | FALSE | Store batches for replay |
| `FEAT_MULTILINE_STORAGE_TTL` | 3600 | Storage duration (seconds) |
| `FEAT_MULTILINE_STORAGE_MAX` | 10000 | Max stored batches |

## Client Protocol

### Sending Multiline

```
BATCH +batchid multiline #channel
@batch=batchid PRIVMSG #channel :Line 1
@batch=batchid PRIVMSG #channel :Line 2
@batch=batchid PRIVMSG #channel :Line 3
BATCH -batchid
```

### Receiving Multiline

```
:nick!user@host BATCH +batchid multiline #channel
@batch=batchid :nick!user@host PRIVMSG #channel :Line 1
@batch=batchid :nick!user@host PRIVMSG #channel :Line 2
@batch=batchid :nick!user@host PRIVMSG #channel :Line 3
:nick!user@host BATCH -batchid
```

## P10 Protocol

### ML Token (MULTILINE)

**Format**:
```
[NUMERIC] ML [+|-|c]<batchid> <target> :<text>
```

**Prefixes**:
- `+` - Start batch (first line)
- (none) - Continue batch
- `-` - End batch (last line)
- `c` - Continuation (partial line split for length)

**Examples**:
```
ABAAB ML +abc123 #channel :First line
ABAAB ML abc123 #channel :Middle line
ABAAB ML -abc123 #channel :Last line
```

## Lag Discounting

Instead of full fake lag per line, multiline batches get discounted lag:

1. Lag accumulates during batch
2. On batch close, discount applied
3. `LAG_DISCOUNT=50` means 50% of normal lag

**Example** (4 lines, 100ms lag each):
- Normal: 400ms lag
- Multiline (50%): 200ms lag
- Multiline + recipient discount (25%): 100ms lag

## Legacy Fallback

For clients without `draft/multiline`:

1. **Below threshold**: Send all lines normally
2. **Above threshold**: Send preview + notice

**Preview** (threshold=3, max_lines=5):
```
:nick!user@host PRIVMSG #channel :Line 1
:nick!user@host PRIVMSG #channel :Line 2
:nick!user@host PRIVMSG #channel :Line 3
:nick!user@host PRIVMSG #channel :[...]
:nick!user@host PRIVMSG #channel :Line 10 (last)
```

**Notice** (if FALLBACK_NOTIFY=TRUE):
```
:server NOTICE nick :Message truncated (10 lines, only 5 shown). Upgrade your client for full multiline support.
```

## Echo Protection

Prevents clients from causing echo amplification:

1. Track input bytes during batch
2. Track output bytes on echo-message
3. If `output > input * ECHO_MAX_FACTOR`, truncate

This prevents a small batch from exploding into a huge echo.

## S2S Storage

When `STORAGE_ENABLED=TRUE`:
- Batches stored in memory for TTL duration
- Late-linking servers can request batch replay
- Used for chathistory multiline reconstruction

## Capability Advertisement

```
draft/multiline=max-bytes=4096,max-lines=24
```

## Example Configuration

```
features {
    "CAP_multiline" = "TRUE";
    "MULTILINE_MAX_BYTES" = "4096";
    "MULTILINE_MAX_LINES" = "24";
    "MULTILINE_LAG_DISCOUNT" = "50";
    "MULTILINE_CHANNEL_LAG_DISCOUNT" = "75";
    "MULTILINE_ECHO_PROTECT" = "TRUE";
    "MULTILINE_LEGACY_THRESHOLD" = "3";
    "MULTILINE_LEGACY_MAX_LINES" = "5";
    "MULTILINE_FALLBACK_NOTIFY" = "TRUE";
};
```

---

*Part of the Nefarious IRCd IRCv3.2+ upgrade project.*

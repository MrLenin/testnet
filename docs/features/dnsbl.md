# Native DNSBL

Built-in DNS-based blocklist checking for Nefarious IRCd.

**Branch**: `feature/native-dnsbl-gitsync`

## Overview

Native DNSBL replaces external DNSBL scripts with a built-in asynchronous DNS lookup system. This provides better performance through caching, non-blocking operation, and tighter integration with the IRCd.

## Architecture

```
Client Connect
      │
      ▼
┌──────────────────┐
│ Registration     │
│ - Check cache    │◄────┐
│ - DNS lookup     │     │
└────────┬─────────┘     │
         │               │
         ▼               │
┌──────────────────┐     │
│ c-ares async DNS │     │
└────────┬─────────┘     │
         │               │
         ▼               │
┌──────────────────┐     │
│ Result Handler   │─────┘
│ - Cache result   │ (Cache)
│ - Apply action   │
└──────────────────┘
```

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_NATIVE_DNSBL` | FALSE | Enable native DNSBL lookups |
| `FEAT_DNSBL_TIMEOUT` | 5 | DNS query timeout (seconds) |
| `FEAT_DNSBL_CACHETIME` | 3600 | Result cache duration (seconds) |
| `FEAT_DNSBL_BLOCKMSG` | "Your IP is listed..." | Message to blocked users |

## DNSBL Configuration Block

```
DNSBL {
    zone = "dnsbl.example.org";
    reply = "127.0.0.2";     # Trigger on this response
    action = "gline";        # kill, gline, or mark
    duration = "1d";         # For gline action
    reason = "Listed in example DNSBL";
    mark = "+d";             # User mode for mark action
};
```

## Actions

| Action | Description |
|--------|-------------|
| `kill` | Immediately disconnect the user |
| `gline` | Apply a G-line for the configured duration |
| `mark` | Set user modes (e.g., +d for DNSBL-marked) |

## DNS Query Format

For IP `192.0.2.1`, queries `1.2.0.192.dnsbl.example.org`.

**IPv4**: Reverse octets, append zone
**IPv6**: Reverse nibbles, append zone

## Caching

- Results are cached for `DNSBL_CACHETIME` seconds
- Both positive (listed) and negative (not listed) results are cached
- Cache key: IP address + zone
- Cache reduces DNS load significantly for repeat connections

## Example Workflow

1. User connects from 192.0.2.1
2. IRCd checks cache for this IP + configured zones
3. Cache miss: async DNS query to `1.2.0.192.dnsbl.example.org`
4. DNS returns `127.0.0.2` (match)
5. Action applied: user G-lined for 1 day
6. Result cached for future connections from same IP

## Multiple Zones

Configure multiple DNSBL blocks for different blocklists:

```
DNSBL {
    zone = "dnsbl.dronebl.org";
    reply = "127.0.0.3";
    action = "gline";
    duration = "1d";
};

DNSBL {
    zone = "tor.dan.me.uk";
    reply = "127.0.0.100";
    action = "mark";
    mark = "+T";  # Tor exit node
};
```

## Build Requirements

```bash
./configure --with-dnsbl
```

Requires: `libc-ares-dev` (c-ares async DNS library)

## Local-Only Operation

DNSBL checking is local to each server - there is no P10 protocol for DNSBL. Each server performs its own lookups and applies actions independently.

---

*Part of the Nefarious IRCd IRCv3.2+ upgrade project.*

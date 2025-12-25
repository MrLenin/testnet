# IRCv3 WebSocket Extension Investigation

## Status: IMPLEMENTED (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/websocket

**Capability**: None (transport layer, not IRC capability)

**Priority**: HIGH - Native WebSocket support is standard in modern IRC servers

**Feature Flag**: `FEAT_DRAFT_WEBSOCKET` (enabled by default)

**Branch**: `ircv3.2-upgrade` (commit `eb63ab4`)

---

## Implementation Status

Native WebSocket support has been implemented in Nefarious, achieving feature parity with other major IRC servers.

### Files Modified

| File | Changes |
|------|---------|
| `include/client.h` | Added `FLAG_WEBSOCKET`, `FLAG_WSNEEDHANDSHAKE` flags |
| `include/listener.h` | Added `LISTEN_WEBSOCKET` flag |
| `include/websocket.h` | New header for WebSocket functions |
| `include/ircd_features.h` | Added `FEAT_DRAFT_WEBSOCKET` |
| `ircd/websocket.c` | New WebSocket implementation (~400 lines) |
| `ircd/s_bsd.c` | WebSocket connection accept, frame wrap/unwrap |
| `ircd/packet.c` | WebSocket handshake handling |
| `ircd/ircd_parser.y` | WebSocket listener configuration |
| `ircd/ircd_lexer.l` | WEBSOCKET token |
| `ircd/ircd_features.c` | Feature registration |
| `ircd/Makefile.in` | Added websocket.c to build |

### Configuration

```
Port {
    port = 8080;
    websocket = yes;
    ssl = yes;  /* Recommended for browser clients */
};
```

To disable WebSocket support:
```
features {
    "DRAFT_WEBSOCKET" = "FALSE";
};
```

### Implementation Details

- **No external library required** - Uses OpenSSL (already linked) for SHA1/Base64
- **Integrated with event loop** - No threading, uses existing poll/epoll/kqueue
- **RFC 6455 compliant** - Full WebSocket protocol support
- **IRCv3 subprotocols** - Supports `binary.ircv3.net` and `text.ircv3.net`
- **SSL support** - Works with existing TLS infrastructure

---

## Why High Priority?

Native WebSocket support is implemented in all major modern IRC servers:
- **Ergo** - Native WebSocket
- **InspIRCd** - Native WebSocket
- **UnrealIRCd** - Native WebSocket
- **Nefarious** - ✅ Native WebSocket (implemented)

---

## Specification Summary

The WebSocket extension defines how IRC can be transported over WebSocket connections instead of raw TCP. This enables:
- Browser-based IRC clients (The Lounge, Kiwi IRC, gamja)
- Firewall traversal (port 80/443)
- Modern web application integration
- Mobile hybrid apps
- Single-port deployment (IRC + Web on 443)

---

## WebSocket Subprotocols

| Subprotocol | Description | Status |
|-------------|-------------|--------|
| `binary.ircv3.net` | Carries arbitrary bytes (required) | ✅ Supported |
| `text.ircv3.net` | UTF-8 only messages (recommended) | ✅ Supported |

---

## Message Format

Each WebSocket message:
- Contains a single IRC line
- MUST NOT include trailing `\r` or `\n`
- Uses text frames for `text.ircv3.net`
- Uses binary frames for `binary.ircv3.net`

**Example**:
```
WebSocket Message: "PRIVMSG #channel :Hello world"
```
(No newline at end)

---

## Connection Flow

### Client Connection

```
1. Client opens WebSocket to wss://irc.example.org:443/
2. Client requests subprotocol: binary.ircv3.net
3. Server accepts connection with subprotocol
4. Client sends IRC commands as WebSocket messages
5. Server sends IRC responses as WebSocket messages
```

### Handshake Example

```
GET /irc HTTP/1.1
Host: irc.example.org
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: ...
Sec-WebSocket-Protocol: binary.ircv3.net, text.ircv3.net
Sec-WebSocket-Version: 13

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: ...
Sec-WebSocket-Protocol: binary.ircv3.net
```

---

## UTF-8 Handling

### For `text.ircv3.net` Clients

Server MUST NOT relay non-UTF-8 content.

Options:
1. Replace invalid bytes with U+FFFD (replacement character)
2. Drop message entirely
3. Sanitize before sending

### For `binary.ircv3.net` Clients

All bytes are valid; no conversion needed.

---

## Architecture

### Native Implementation (Current)

WebSocket is implemented directly in Nefarious:

```
Client <--WebSocket--> Nefarious
                    |
                    +--TCP--> Other Servers
```

**Pros**: Single process, lowest latency, no dependencies
**Implementation**: Custom RFC 6455 implementation using OpenSSL for crypto

### Alternative: WebSocket Proxy

For deployments preferring a proxy:

```
Client <--WebSocket--> ws-proxy <--TCP--> Nefarious
```

Options: webircgateway, websockify, etc.

---

## Security Considerations

1. **Origin validation**: Restrict to trusted web origins
2. **SSL/TLS**: Always use wss:// in production
3. **Rate limiting**: WebSocket connections use existing flood protection
4. **DoS protection**: Frame size limits, ping/pong handling
5. **Masking verification**: Client frames must be masked per RFC 6455

---

## Implementation Details

### websocket.c Functions

| Function | Purpose |
|----------|---------|
| `websocket_handshake()` | Handles HTTP Upgrade handshake |
| `websocket_decode_frame()` | Parses incoming WebSocket frames |
| `websocket_encode_frame()` | Creates outgoing WebSocket frames |
| `websocket_handle_control()` | Handles PING/PONG/CLOSE frames |

### Frame Processing

**Incoming (s_bsd.c read_packet)**:
1. Read raw data from socket
2. For WebSocket clients, decode frame
3. Extract IRC message from payload
4. Process as normal IRC command

**Outgoing (s_bsd.c deliver_it)**:
1. Collect data from message queue
2. For WebSocket clients, encode as frame
3. Send frame (with SSL_write if TLS)

### Control Frames

| Opcode | Handling |
|--------|----------|
| PING (0x9) | Reply with PONG |
| PONG (0xA) | Acknowledged, no action |
| CLOSE (0x8) | Close connection gracefully |

---

## Client Support

### Browser Clients

| Client | Notes |
|--------|-------|
| The Lounge | Self-hosted web client |
| Kiwi IRC | Hosted or self-hosted |
| gamja | Minimal web client |
| IRCCloud | Commercial service |

### Server Support

| Server | Native WebSocket |
|--------|------------------|
| Ergo | Yes |
| InspIRCd | Yes |
| UnrealIRCd | Yes |
| Nefarious | ✅ Yes |

---

## References

- **Spec**: https://ircv3.net/specs/extensions/websocket
- **WebSocket RFC**: RFC 6455
- **WEBIRC**: https://ircv3.net/specs/extensions/webirc

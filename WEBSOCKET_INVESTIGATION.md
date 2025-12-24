# IRCv3 WebSocket Extension Investigation

## Status: HIGH PRIORITY (Draft Specification)

**Specification**: https://ircv3.net/specs/extensions/websocket

**Capability**: None (transport layer, not IRC capability)

**Priority**: HIGH - Native WebSocket support is standard in modern IRC servers

---

## Why High Priority?

Native WebSocket support is implemented in all major modern IRC servers:
- **Ergo** - Native WebSocket
- **InspIRCd** - Native WebSocket
- **UnrealIRCd** - Native WebSocket

Nefarious is notably missing this feature, which limits its appeal for modern deployments where browser-based clients are increasingly common.

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

| Subprotocol | Description |
|-------------|-------------|
| `binary.ircv3.net` | Carries arbitrary bytes (required) |
| `text.ircv3.net` | UTF-8 only messages (recommended) |

Servers MUST support `binary.ircv3.net`.
Servers SHOULD support `text.ircv3.net`.

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

## Implementation Architecture

### Option A: Native WebSocket in Nefarious

Add WebSocket listener directly to Nefarious:

```
Client <--WebSocket--> Nefarious
                    |
                    +--TCP--> Other Servers
```

**Pros**: Single process, lowest latency
**Cons**: Significant C code changes, library dependency

### Option B: WebSocket Proxy

Run a separate WebSocket-to-TCP proxy:

```
Client <--WebSocket--> ws-proxy <--TCP--> Nefarious
```

**Pros**: No IRCd changes, reusable
**Cons**: Extra hop, more deployment complexity

### Option C: HTTP Server Integration

Use existing HTTP server with WebSocket support:

```
Client <--WebSocket--> nginx/caddy <--TCP--> Nefarious
```

**Pros**: Mature WebSocket implementation
**Cons**: Configuration complexity

---

## Option A: Native Implementation

### Library Options

| Library | License | Notes |
|---------|---------|-------|
| libwebsockets | MIT | Full-featured, complex |
| wslay | MIT | Lightweight, callback-based |
| mongoose | GPL | Embedded web server |

### Files to Modify (Nefarious)

| File | Changes |
|------|---------|
| `ircd/s_bsd.c` | Add WebSocket listener |
| `ircd/packet.c` | WebSocket frame parsing |
| `ircd/send.c` | WebSocket frame encoding |
| `include/listener.h` | WebSocket listener type |
| `ircd/ircd.c` | WebSocket initialization |
| `configure.in` | WebSocket library detection |

### Listener Configuration

```
listener {
    host = "0.0.0.0";
    port = 8080;
    websocket = yes;
    ssl = yes;
};
```

---

## Option B: WebSocket Proxy

### Existing Solutions

| Proxy | Language | Notes |
|-------|----------|-------|
| webircgateway | Go | Feature-rich, production-ready |
| websockify | Python | Generic WebSocket-to-TCP |
| KiwiIRC | Node.js | IRC-specific |

### webircgateway Configuration

```yaml
servers:
  - bind: "0.0.0.0:8080"
    ssl: true
    upstream: "127.0.0.1:6667"
    webirc_password: "secret"
```

---

## WEBIRC Support

WebSocket proxies typically use WEBIRC to pass client IP:

```
WEBIRC <password> <gateway> <hostname> <ip>
```

**Example**:
```
WEBIRC secret webircgateway client.example.com 192.168.1.100
```

Nefarious already supports WEBIRC (`CMD_WEBIRC`).

---

## Implementation Phases

### Phase 1: Proxy-Based (Recommended First)

1. Deploy webircgateway alongside Nefarious
2. Configure WEBIRC password
3. Test with web clients

**Effort**: Low (4-8 hours ops work, no code changes)

### Phase 2: Native Integration (Optional)

1. Add libwebsockets dependency
2. Implement WebSocket listener
3. Handle frame parsing/encoding
4. Add configuration options

**Effort**: Very High (80-120 hours)

---

## Configuration Options (Option A)

```
features {
    "WEBSOCKET_ENABLE" = "TRUE";
    "WEBSOCKET_PORT" = "8080";
    "WEBSOCKET_SSL" = "TRUE";
    "WEBSOCKET_ORIGIN" = "*";  /* CORS origin */
    "WEBSOCKET_SUBPROTOCOL" = "binary.ircv3.net";
};
```

---

## Security Considerations

1. **Origin validation**: Restrict to trusted web origins
2. **SSL/TLS**: Always use wss:// in production
3. **Rate limiting**: WebSocket connections may need different limits
4. **WEBIRC trust**: Only accept from trusted proxies
5. **DoS protection**: WebSocket ping/pong, frame limits

---

## CORS and Origin

For browser clients, servers may need to validate Origin header:

```c
/* Validate Origin in WebSocket handshake */
const char *origin = get_header("Origin");
if (!is_allowed_origin(origin))
    return reject_connection();
```

---

## Message Size Limits

WebSocket frames can be large. Consider:
- Maximum frame size
- Maximum message size
- Fragmentation handling

IRC messages are typically < 512 bytes, so limits can be conservative.

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Proxy deployment | Low | Low |
| WEBIRC configuration | Low | Low |
| Native WebSocket | Very High | High |
| SSL integration | Medium | Medium |
| UTF-8 handling | Low | Low |

**Total**:
- Proxy approach: Low effort (4-8 hours ops)
- Native approach: Very High effort (80-120 hours dev)

---

## Recommendation

### Short-term
1. **Deploy webircgateway** for immediate WebSocket support
2. **Configure WEBIRC** to pass real client IPs
3. **Use SSL/TLS** - Required for browser security

### Long-term
1. **Implement native WebSocket** - Parity with Ergo/UnrealIRCd/InspIRCd
2. **Use libwebsockets** - MIT licensed, well-maintained
3. **Integrate with existing SSL** - Reuse OpenSSL infrastructure

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
| Nefarious | No (proxy only) |

---

## webircgateway Deployment

### Docker Example

```yaml
services:
  webircgateway:
    image: prawnsalad/webircgateway
    ports:
      - "8080:80"
    environment:
      - GATEWAY_LISTEN=0.0.0.0:80
      - GATEWAY_UPSTREAM=nefarious:6667
      - GATEWAY_WEBIRC_PASSWORD=secret
    depends_on:
      - nefarious
```

---

## References

- **Spec**: https://ircv3.net/specs/extensions/websocket
- **webircgateway**: https://github.com/kiwiirc/webircgateway
- **WebSocket RFC**: RFC 6455
- **WEBIRC**: https://ircv3.net/specs/extensions/webirc

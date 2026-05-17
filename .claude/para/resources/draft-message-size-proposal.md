# draft/message-size - Extended Message Size Negotiation

**Status:** Draft Proposal
**Author:** Afternet Development Team
**Created:** January 2026

## Abstract

This document specifies a mechanism for IRC clients and servers to negotiate message sizes larger than the RFC 1459/2812 limit of 512 bytes. The extension uses IRCv3 capability negotiation to maintain full backward compatibility.

## Motivation

The 512-byte message limit defined in RFC 1459 (1993) constrains modern IRC features:

- **Metadata values** limited to ~300 bytes after protocol overhead
- **Long messages** require fragmentation (multiline batches)
- **Rich content** (URLs, JSON payloads) frequently truncated
- **Channel topics** artificially constrained

The message-tags extension already demonstrates that exceeding 512 bytes is practical with proper negotiation (8191 bytes for tags + 512 for base message). This proposal extends that approach to the base message itself.

## Design Principles

1. **Backward Compatible**: Non-negotiating clients/servers see no change
2. **Fail-Safe**: Use 512 bytes until negotiation succeeds
3. **Simple**: Minimal protocol changes
4. **Incremental**: Servers can advertise conservative limits initially

## Capability Specification

### Capability Name

```
message-size
```

### Capability Value

The server advertises its maximum supported message size as the capability value:

```
CAP * LS :message-size=4096 sasl multi-prefix
```

If no value is provided, the default maximum is **4096 bytes**.

### Negotiation

**Client requests the capability:**
```
CAP REQ :message-size
```

**Server acknowledges:**
```
CAP ACK :message-size
```

Upon successful `CAP ACK`, both client and server MAY send and MUST accept messages up to the negotiated size.

### Timing Constraint

**Critical:** Until `CAP ACK` is received, both parties MUST use 512-byte messages. This ensures:
- CAP negotiation itself works with legacy-size messages
- Partial negotiation failures don't corrupt the stream

### Size Accounting

The negotiated size applies to the **entire message line**, including:
- Message tags (if `message-tags` also negotiated)
- Source prefix
- Command and parameters
- Trailing CR-LF

This differs from message-tags which uses separate budgets. The simpler "total line size" model is chosen because:
1. Easier to implement (single buffer size)
2. No ambiguity about what counts where
3. Clients already handle variable-size lines

### Recommended Sizes

| Size | Use Case |
|------|----------|
| 512 | RFC default (no negotiation) |
| 2048 | Conservative extension |
| 4096 | Recommended default for new implementations |
| 8192 | High-capacity servers |
| 16384 | Maximum recommended |

Sizes larger than 16KB are NOT RECOMMENDED due to:
- Memory allocation concerns
- DoS potential
- Diminishing returns

## ISUPPORT Integration

After successful CAP negotiation, servers SHOULD advertise the active message size via ISUPPORT:

```
:server 005 nick LINELEN=4096 :are supported by this server
```

The `LINELEN` parameter is informational only. The authoritative negotiation happens via CAP.

If a client does not negotiate `message-size`, ISUPPORT SHOULD NOT include `LINELEN` (or should show `LINELEN=512`).

## Error Handling

### Client Sends Oversized Message (No CAP)

If a client sends a message exceeding 512 bytes without negotiating `message-size`:

```
:server 417 nick :Input line was too long
```

The server MUST reject (not truncate) the message.

### Client Sends Message Exceeding Negotiated Size

Same error, but threshold is the negotiated size:

```
:server 417 nick :Input line was too long
```

### Server Would Send Oversized Message

If a server needs to send a message that would exceed the client's negotiated size, the server SHOULD:
1. Fragment into multiple messages if semantically valid
2. Truncate with indication (e.g., `...`) for display-only content
3. Omit the message with an error if neither is possible

## Interaction with Message Tags

When both `message-size` and `message-tags` are negotiated:

**Option A (Recommended): Unified Budget**
- The `message-size` value is the total line limit
- Tags count against this budget
- Simpler implementation

**Option B: Separate Budgets**
- Tags have their own 8191-byte budget (per message-tags spec)
- Base message has `message-size` budget
- More complex but preserves message-tags semantics

Implementations SHOULD use Option A for simplicity. The message-tags spec's separate accounting was a workaround for the 512-byte limit; with `message-size` negotiated, unified accounting is cleaner.

## Server-to-Server Considerations

Server-to-server protocols (P10, TS6, etc.) are outside the scope of this specification. IRC specifications define client-to-server behavior only; backend implementation is left to server developers.

Implementors should ensure their S2S protocol can handle messages up to the size advertised to clients. Networks SHOULD NOT advertise `message-size` to clients until all servers on the network support the capability, to avoid message delivery failures or unexpected truncation.

## Security Considerations

### Memory Exhaustion

Larger messages require larger buffers. Servers SHOULD:
- Limit maximum advertised size based on available memory
- Use per-connection buffer limits
- Implement flood protection independent of message size

### Amplification

Larger messages could amplify broadcast operations (e.g., channel messages). Existing flood protection mechanisms remain applicable.

### Parsing Complexity

Larger messages don't introduce new parsing complexity—the format is unchanged, only the size constraint is relaxed.

## Implementation Notes

### Buffer Sizing

Implementations typically use fixed-size receive buffers. With negotiation:
- Allocate default 512-byte buffers initially
- Resize or reallocate after successful CAP negotiation
- Consider buffer pooling for efficiency

### Backward Compatibility Testing

Implementations MUST be tested against:
1. Clients that don't send CAP at all
2. Clients that send CAP but don't request `message-size`
3. Servers that don't advertise `message-size`
4. Mixed networks with partial support

## Examples

### Successful Negotiation

```
C: CAP LS 302
S: CAP * LS :message-size=4096 sasl multi-prefix
C: CAP REQ :message-size sasl
S: CAP * ACK :message-size sasl
C: CAP END
C: NICK alice
C: USER alice 0 * :Alice
S: :server 001 alice :Welcome to the network
S: :server 005 alice LINELEN=4096 ... :are supported by this server
```

After this exchange, both sides accept messages up to 4096 bytes.

### No Server Support

```
C: CAP LS 302
S: CAP * LS :sasl multi-prefix
C: CAP REQ :sasl
S: CAP * ACK :sasl
C: CAP END
```

Client sees no `message-size` capability. 512-byte limit remains in effect.

### Client Doesn't Request

```
C: CAP LS 302
S: CAP * LS :message-size=4096 sasl
C: CAP REQ :sasl
S: CAP * ACK :sasl
C: CAP END
```

Client chose not to request `message-size`. 512-byte limit remains.

## Open Questions

1. **Should there be a client-requested size?**
   - Current proposal: Server advertises max, client gets that max if it requests
   - Alternative: Client could request a specific size (`CAP REQ :message-size=2048`)

2. **Interaction with existing TOPICLEN/KICKLEN/etc.?**
   - These could be updated to reflect larger sizes
   - Or kept as sub-limits within the larger message budget

3. **S2S protocol implications?**
   - P10 and other S2S protocols may have their own size assumptions
   - Network-wide coordination needed

## References

- [RFC 1459: Internet Relay Chat Protocol](https://datatracker.ietf.org/doc/html/rfc1459)
- [RFC 2812: Internet Relay Chat: Client Protocol](https://datatracker.ietf.org/doc/html/rfc2812)
- [IRCv3 Capability Negotiation](https://ircv3.net/specs/extensions/capability-negotiation)
- [IRCv3 Message Tags](https://ircv3.net/specs/extensions/message-tags)
- [Modern IRC ISUPPORT](https://modern.ircdocs.horse/#rplisupport-005)

## Changelog

- 2026-01: Initial draft

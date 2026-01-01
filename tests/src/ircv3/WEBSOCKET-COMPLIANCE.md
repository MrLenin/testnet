# WebSocket RFC 6455 Compliance Notes

This document tracks where Nefarious IRCd's WebSocket implementation deviates from strict RFC 6455 requirements. Tests have been adjusted to accept the actual server behavior rather than fail, but these deviations are documented here for awareness.

## Summary

| RFC Section | Requirement | Nefarious Behavior | Severity |
|-------------|-------------|-------------------|----------|
| §4.2.2 | No protocol header if client didn't request | Sends default `binary.ircv3.net` | Low |
| §5.1 | MUST close on unmasked client frame | Accepts and processes | Medium |
| §5.2 | MUST fail on non-zero RSV bits | Ignores RSV bits | Low |
| §5.2 | MUST fail on reserved opcodes | Ignores reserved opcodes | Low |
| §5.5 | Control frame payload ≤125 bytes | Accepts >125 bytes | Low |

## Detailed Findings

### 1. Default Subprotocol Without Client Request

**RFC 6455 §4.2.2:**
> If the server does not wish to agree to one of the suggested subprotocols, it MUST NOT send back a `Sec-WebSocket-Protocol` header field in its response.

**Nefarious behavior:** Sends `Sec-WebSocket-Protocol: binary.ircv3.net` even when client doesn't include `Sec-WebSocket-Protocol` in request.

**Test:** `websocket.test.ts` → "should accept handshake without subprotocol"

**Impact:** Low - clients should ignore unexpected headers. Well-behaved clients won't be affected.

**File:** [websocket.test.ts:134-155](websocket.test.ts#L134-L155)

---

### 2. Unmasked Client Frames Accepted

**RFC 6455 §5.1:**
> A server MUST close the connection upon receiving a frame that is not masked.

**Nefarious behavior:** Accepts and processes unmasked frames from clients.

**Test:** `websocket.test.ts` → "should handle unmasked client frames"

**Impact:** Medium - masking prevents cache poisoning attacks on intermediary proxies. In practice, IRC-over-WebSocket is typically over TLS which mitigates this.

**File:** [websocket.test.ts:555-598](websocket.test.ts#L555-L598)

---

### 3. RSV Bits Ignored

**RFC 6455 §5.2:**
> RSV1, RSV2, RSV3: 1 bit each. MUST be 0 unless an extension is negotiated that defines meanings for non-zero values.

**Nefarious behavior:** Ignores RSV bits entirely, doesn't close connection.

**Test:** `websocket-edge.test.ts` → "should handle frames with RSV bits set (no extensions)"

**Impact:** Low - reserved for future extensions. If extensions were later implemented, there could be confusion, but current behavior is harmless.

**File:** [websocket-edge.test.ts:357-398](websocket-edge.test.ts#L357-L398)

---

### 4. Reserved Opcodes Ignored

**RFC 6455 §5.2:**
> If an unknown opcode is received, the receiving endpoint MUST Fail the WebSocket Connection.

Reserved opcodes: 0x03-0x07 (data frames), 0x0B-0x0F (control frames)

**Nefarious behavior:** Silently ignores frames with reserved opcodes.

**Test:** `websocket-edge.test.ts` → "should handle reserved opcode gracefully"

**Impact:** Low - no legitimate client sends reserved opcodes. Silent ignore vs connection close is a minor difference.

**File:** [websocket-edge.test.ts:400-442](websocket-edge.test.ts#L400-L442)

---

### 5. Oversized Control Frame Accepted

**RFC 6455 §5.5:**
> All control frames MUST have a payload length of 125 bytes or less and MUST NOT be fragmented.

**Nefarious behavior:** Accepts PING frames with payloads >125 bytes.

**Test:** `websocket-edge.test.ts` → "should handle control frame with >125-byte payload"

**Impact:** Low - no legitimate client sends oversized control frames. The server handles it gracefully.

**File:** [websocket-edge.test.ts:455-489](websocket-edge.test.ts#L455-L489)

---

## Features Not Tested (May Not Be Implemented)

These RFC 6455 features were not tested because implementation status is unknown:

1. **Frame fragmentation reassembly** (§5.4) - Tests send fragmented frames but don't verify server reassembles them correctly. The fragmentation tests check the server doesn't crash, but message delivery wasn't verified.

2. **Close frame status codes** - Server may not validate close codes are in valid ranges (1000-1015, 3000-4999).

3. **UTF-8 validation** - RFC requires TEXT frames contain valid UTF-8. Server may not validate.

4. **Extension negotiation** - No extensions tested (permessage-deflate, etc.)

---

## Recommendations

If strict RFC 6455 compliance is desired, the following changes to Nefarious would be needed:

1. **websocket.c** - Don't send `Sec-WebSocket-Protocol` unless client requested
2. **websocket.c** - Check mask bit in `websocket_decode_frame()`, close if not set
3. **websocket.c** - Validate RSV bits are zero in frame header
4. **websocket.c** - Reject unknown opcodes with close frame (1002 protocol error)
5. **websocket.c** - Validate control frame payload length ≤125

These are relatively low-priority since the current behavior is safe and interoperable with standard WebSocket clients.

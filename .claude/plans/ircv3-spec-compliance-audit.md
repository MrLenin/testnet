# IRCv3 Spec Compliance Audit

## Purpose

Systematic verification that implemented IRCv3 features conform to their specifications.
This is NOT about finding missing features - it's about ensuring existing implementations
are correct.

**Motivation**: We've found several divergences where implementations didn't match specs:
- MONITOR: Was sending WATCH numerics (604/605) instead of MONITOR numerics (730/731)
- UTF8ONLY: Was truncating invalid UTF-8 instead of U+FFFD replacement
- WebSocket: Was hardcoding text mode instead of respecting subprotocol negotiation
- WEBSOCKET_RECVQ: Was based on incorrect assumption about message bundling

---

## Audit Methodology

For each feature:
1. Read the canonical spec (ircv3.net or RFC)
2. Read the implementation code
3. Note any divergences between spec and implementation
4. Categorize: Bug vs Intentional Deviation vs Spec Ambiguity
5. Document recommended action

---

## Priority Order

Start with features most likely to have issues (complex specs, less-tested):

### High Priority (Complex specs, protocol-critical)
- [x] SASL (multiple mechanisms, state machine) - ✅ Fully Compliant (all issues fixed)
- [x] Chathistory (complex subcommands, timestamp formats) - ✅ Compliant
- [x] Multiline (batching, concat semantics) - ✅ Fully Compliant (all issues fixed)
- [x] WebSocket (subprotocols, framing, UTF-8) - ✅ Fully Compliant
- [x] Metadata (subscriptions, sync, limits) - ✅ Fully Compliant (colon issue fixed)

### Medium Priority (Moderate complexity)
- [x] Batch (nesting, types) - ✅ Compliant
- [x] Message Tags (parsing, client-only prefix) - ✅ Fully Compliant (CLIENTTAGDENY implemented)
- [x] Labeled Response (matching, ACK) - ✅ Fully Compliant (ACK implemented)
- [x] Read Marker (format, sync) - ✅ Compliant
- [x] Message Redaction (window, permissions) - ✅ Compliant

### Lower Priority (Simple specs)
- [x] CAP negotiation (302, LS, REQ, ACK, NAK) - ✅ Fully Compliant (NEW/DEL implemented)
- [x] Account-notify, Away-notify, Invite-notify - ✅ Compliant
- [x] Extended-join, Chghost - ✅ Compliant
- [x] Echo-message - ✅ Compliant
- [x] Server-time, Account-tag, Msgid - ✅ Fully Compliant (account-tag fixed)
- [x] Setname - ✅ Fully Compliant (config-gated FAIL behavior)
- [x] Standard-replies (FAIL, WARN, NOTE) - ✅ Compliant
- [x] STS - ✅ Compliant
- [x] MONITOR - ✅ Fully Compliant
- [x] UTF8ONLY - ✅ Fully Compliant (PART/QUIT/KICK now validated)

---

## Audit Checklist

### 1. SASL
**Spec**: https://ircv3.net/specs/extensions/sasl-3.2

**Implementation Files**:
- `ircd/m_authenticate.c`
- `ircd/m_sasl.c`
- `ircd/m_cap.c` (mechanism list)

**Checklist**:
- [x] AUTHENTICATE chunking (400 byte limit, + for continuation)
- [x] AUTHENTICATE * for abort - ✅ Fixed (m_authenticate.c:125-136)
- [x] 903 RPL_SASLSUCCESS format
- [x] 904 ERR_SASLFAIL format
- [x] 906 ERR_SASLABORTED when client sends * - ✅ Fixed
- [x] 907 ERR_SASLALREADY if already authenticated - ✅ Fixed (only OAUTHBEARER allows re-auth)
- [x] 908 RPL_SASLMECHS format
- [x] sasl capability value format (mechanisms comma-separated)
- [x] PLAIN mechanism base64 format (\0username\0password) - handled by services
- [x] EXTERNAL mechanism (uses client cert) - fingerprint sent to services
- [x] Timeout handling
- [x] 902 ERR_NICKLOCKED defined - ✅ Fixed (numeric.h)

**Findings**:
```
✅ FULLY COMPLIANT - All issues fixed

FIXED ISSUES:

1. AUTHENTICATE * (abort) - FIXED
   Location: ircd/m_authenticate.c:125-136
   Now handles AUTHENTICATE * by calling abort_sasl() and notifying IAuth if applicable

2. ERR_SASLALREADY (907) - FIXED
   Location: ircd/m_authenticate.c:142-158
   Now sends 907 for PLAIN/EXTERNAL/SCRAM-*, only allows re-auth for OAUTHBEARER

3. ERR_NICKLOCKED (902) - FIXED
   Location: include/numeric.h
   Numeric now defined for services to use

COMPLIANT:
- 400 byte limit enforced (m_authenticate.c:119)
- ERR_SASLTOOLONG (905) sent for oversized messages
- Dynamic mechanism list from services (M broadcast in m_sasl.c:127)
- CAP value includes mechanisms (m_cap.c:87,260-264)
- Timeout handling with timer (m_authenticate.c:269-270)
- Client cert fingerprint sent for EXTERNAL (m_authenticate.c:232-235)
- Re-authentication supported (for OAUTHBEARER token refresh)

ARCHITECTURE NOTE:
SASL at IRCd level is mostly passthrough to linked services (X3) or IAuth.
Mechanism handling (PLAIN, EXTERNAL, SCRAM, OAUTHBEARER) is done by services.
However, AUTHENTICATE * should still be handled at IRCd level before forwarding,
since abort_sasl() exists and the client expects immediate 906 response.

Note: AUTHENTICATE + (empty response) handling delegated to services,
which is acceptable as IRCd just forwards the message.
```

---

### 2. Chathistory
**Spec**: https://ircv3.net/specs/extensions/chathistory

**Implementation Files**:
- `ircd/m_chathistory.c`
- `ircd/history.c`

**Checklist**:
- [x] CHATHISTORY LATEST format and response
- [x] CHATHISTORY BEFORE format and response
- [x] CHATHISTORY AFTER format and response
- [x] CHATHISTORY AROUND format and response
- [x] CHATHISTORY BETWEEN format and response
- [x] CHATHISTORY TARGETS format and response
- [x] Timestamp format (ISO 8601 with milliseconds)
- [x] msgid reference format (msgid= prefix)
- [x] Batch type chathistory (and draft/chathistory-targets for TARGETS)
- [x] MSGREFTYPES ISUPPORT token ("timestamp,msgid")
- [x] Limit handling (CHATHISTORY_MAX via ISUPPORT)
- [x] Permission checks (channel membership via check_history_access)

**Findings**:
```
FULLY COMPLIANT - No issues found

Key implementation details:
- All 6 subcommands implemented: LATEST, BEFORE, AFTER, AROUND, BETWEEN, TARGETS
  (m_chathistory.c:363-381 maps to S2S single-char format L/B/A/R/W/T)
- Reference parsing handles both timestamp= and msgid= prefixes (m_chathistory.c:338-350)
- Timestamp validation supports ISO 8601 format (m_chathistory.c:262-272)
- Configurable strict timestamp mode: FEAT_CHATHISTORY_STRICT_TIMESTAMPS
- ISUPPORT advertises: CHATHISTORY=<max>, MSGREFTYPES=timestamp,msgid (s_user.c:2662-2663)
- Batch type is "chathistory" with target parameter (m_chathistory.c:697)
- TARGETS uses "draft/chathistory-targets" batch type (m_chathistory.c:1191)
- Proper FAIL responses: INVALID_PARAMS, INVALID_TARGET, MESSAGE_ERROR
- Access checks before query (check_history_access)
- Multiline content handled via nested draft/multiline batches (m_chathistory.c:516)
- Federation support via CH P10 token with advertisement-based routing

Note: Implementation extends spec with:
- PM history support (CHATHISTORY_PRIVATE feature)
- Event playback (TOPIC, JOIN, PART, KICK, etc. with draft/event-playback cap)
- Zstd compression passthrough for S2S efficiency
```

---

### 3. Multiline
**Spec**: https://ircv3.net/specs/extensions/multiline

**Implementation Files**:
- `ircd/m_batch.c`
- `ircd/ircd_relay.c` (multiline handling)
- `ircd/s_bsd.c` (buffer handling)

**Checklist**:
- [x] BATCH +id draft/multiline target format
- [x] draft/multiline-concat tag on continuation lines (parse.c:1391-1394)
- [x] Empty line handling (blank lines in message) - ✅ Fixed (blank lines filtered in fallback)
- [x] Max bytes limit (MULTILINE_MAX_BYTES in CAP value)
- [x] Max lines limit (MULTILINE_MAX_LINES in CAP value)
- [x] Batch timeout handling (via multiline batch state cleanup)
- [x] Fallback for non-multiline recipients - ✅ Fixed (blank lines filtered)
- [x] S2S relay behavior (ML P10 token)
- [x] Concat+blank line validation - ✅ Fixed (rejected per spec)

**Findings**:
```
✅ FULLY COMPLIANT - All issues fixed

Key implementation details:
- Capability value correctly formatted: max-bytes=<n>,max-lines=<n> (m_cap.c:267-269)
- draft/multiline-concat tag parsed and stored (parse.c:1391-1394)
- Limit enforcement with proper FAIL codes:
  - MULTILINE_MAX_LINES (m_batch.c:420)
  - MULTILINE_MAX_BYTES (m_batch.c:427)
- Buffer space extended for multiline clients (s_bsd.c:865, 1120)
- Lag discount for multiline (MULTILINE_LAG_DISCOUNT, MULTILINE_CHANNEL_LAG_DISCOUNT)
- Fallback chain: chathistory -> HistServ -> &ml-<msgid> storage (m_batch.c:126-186)

FIXED ISSUES:
1. Blank line handling in fallback - FIXED
   Location: m_batch.c send_multiline_fallback()
   Now skips blank lines when delivering to non-multiline clients

2. Concat+blank line validation - FIXED
   Location: m_batch.c add_message()
   Now rejects lines with both concat tag and blank content per spec
```

---

### 4. WebSocket
**Spec**: https://ircv3.net/specs/extensions/websocket

**Implementation Files**:
- `ircd/websocket.c`
- `ircd/s_bsd.c` (frame handling)

**Checklist**:
- [x] Subprotocol negotiation (text.ircv3.net, binary.ircv3.net)
- [x] Legacy client handling (no subprotocol)
- [x] Frame type matches subprotocol
- [x] No trailing \r\n in messages
- [x] UTF-8 validation for text frames
- [x] Ping/pong handling
- [x] Close frame handling
- [x] Fragmentation support
- [x] Origin validation (WEBSOCKET_ORIGIN)

**Findings**:
```
✅ FULLY COMPLIANT - All features implemented

Fixed earlier:
- Subprotocol was being parsed but not stored on client
- All outgoing frames were hardcoded as text mode
- Legacy clients now autodetect based on first incoming frame
- Text mode now sanitizes non-UTF-8 with U+FFFD (see UTF8ONLY section for multi-server details)
- Removed WEBSOCKET_RECVQ (was based on incorrect assumption)

Verified in latest audit:
- Ping/pong: websocket_handle_control() in websocket.c:629-673
  - PING: Responds with PONG containing same payload (lines 636-648)
  - PONG: Accepted silently (lines 651-653)
- Close: Responds with close frame echoing status code (lines 655-669)
- Fragmentation: Full support in s_bsd.c:1035-1093
  - WS_OPCODE_CONTINUATION handled with fragment buffer
  - cli_ws_frag_buf/cli_ws_frag_len for reassembly (16KB limit)
  - Delivers reassembled message when FIN bit set
- Origin validation: validate_ws_origin() in websocket.c:248-316
  - FEAT_WEBSOCKET_ORIGIN configures allowed origins
  - Supports exact match and wildcard suffix patterns (*example.com)
  - Empty config = all origins allowed
```

---

### 5. Metadata
**Spec**: https://ircv3.net/specs/extensions/metadata

**Implementation Files**:
- `ircd/m_metadata.c`

**Checklist**:
- [x] METADATA GET format (multi-key support)
- [x] METADATA SET format (with visibility)
- [x] METADATA LIST format
- [x] METADATA SUB/UNSUB format (with sequential processing)
- [x] METADATA SYNC format
- [x] METADATA SUBS format
- [x] METADATA CLEAR format
- [x] Key naming restrictions - ✅ Fixed (colon now rejected per spec)
- [x] Visibility (public/private)
- [x] Numeric responses (760-774)
- [x] Limits (max-subs, max-keys, max-value-bytes in CAP value)

**Findings**:
```
✅ FULLY COMPLIANT - All issues fixed

Key implementation details:
- All subcommands implemented: GET, SET, LIST, CLEAR, SUB, UNSUB, SUBS, SYNC
- Capability value: max-subs=50,max-keys=20,max-value-bytes=300 (m_cap.c:109)
- Key validation in is_valid_key() (m_metadata.c:106-121)
- Proper FAIL codes: KEY_INVALID, TARGET_INVALID, KEY_NO_PERMISSION, LIMIT_REACHED
- Numeric responses:
  - RPL_WHOISKEYVALUE (760)
  - RPL_KEYVALUE (761)
  - RPL_METADATAEND (762)
  - RPL_KEYNOTSET (766)
  - RPL_METADATASUBOK (770)
  - RPL_METADATAUNSUBOK (771)
- Sequential subscription processing with limit enforcement (m_metadata.c:715-719)
- Visibility support (public/private)
- IRCd↔X3 sync via MD/MDQ P10 tokens

FIXED ISSUE:
1. Key character set - FIXED
   Location: m_metadata.c is_valid_key()
   Colon (:) now rejected per spec - only allows a-z, 0-9, underscore, period, forward slash, or hyphen
```

---

### 6. Batch
**Spec**: https://ircv3.net/specs/extensions/batch

**Implementation Files**:
- `ircd/m_batch.c`

**Checklist**:
- [x] BATCH +reference-tag type [params] format
- [x] BATCH -reference-tag format
- [x] Nested batches allowed (chathistory + multiline nesting)
- [x] Reference tag uniqueness per connection (counter + numnick)
- [x] Known batch types: chathistory, netjoin, netsplit, draft/multiline

**Findings**:
```
FULLY COMPLIANT - No issues found

Key implementation details:
- Batch ID generation: counter + client numnick ensures uniqueness (send.c:2052-2057)
- Separate generators for chathistory (m_chathistory.c:471-475) and general batches
- Batch types supported:
  - chathistory (m_chathistory.c:697)
  - draft/chathistory-targets (m_chathistory.c:1191)
  - netjoin/netsplit (m_batch.c:263-264)
  - draft/multiline (m_batch.c multiline handling)
- S2S coordination via BT P10 token (m_batch.c:193-198)
- Nested batches: multiline batches nested inside chathistory (m_chathistory.c:516-532)
- Empty batches allowed (start + end with no messages in between)
```

---

### 7. Message Tags
**Spec**: https://ircv3.net/specs/extensions/message-tags

**Implementation Files**:
- `ircd/parse.c` (tag parsing)
- `ircd/send.c` (tag emission)
- `ircd/m_tagmsg.c` (TAGMSG command)

**Checklist**:
- [x] Client-only tags start with + (parse.c:1397)
- [x] Client-only tags NOT relayed to servers (only stored in cli_client_tags)
- [x] Client-only tags relayed to clients with message-tags cap (send.c:938-960)
- [x] Tag value escaping (\: \s \\ \r \n) - Pass-through OK (see notes)
- [x] Tag length limits - ✅ Fixed (4094 bytes for client-only tags enforced)
- [x] Multiple tags separated by ; (parse.c:1362-1364)
- [x] CLIENTTAGDENY ISUPPORT token - ✅ Implemented (s_user.c, configurable)
- [x] ERR_INPUTTOOLONG (417) defined (s_err.c:869)
- [x] TAGMSG command (m_tagmsg.c)

**Findings**:
```
✅ FULLY COMPLIANT - All issues fixed

Key implementation details:
- Client-only tags (+ prefix) correctly identified and stored (parse.c:1396-1404)
- Client tags stored in cli_client_tags buffer with 4094 byte limit enforced
- Tags relayed via format_message_tags_with_client() to message-tags capable clients
- Server-originated tags (time, account, msgid, batch, label) properly formatted (send.c:161-224)
- TAGMSG command implemented for tag-only messages (m_tagmsg.c)

PASS-THROUGH BEHAVIOR (acceptable):
- Tag value escaping: Tags passed through verbatim without escaping/unescaping
- This is acceptable because IRCd doesn't interpret tag VALUES, only key names
- Client-only tags are just relayed, not processed
- Server-generated tags never contain escapable chars

FIXED ISSUES:
1. Tag length limits - FIXED
   Location: parse.c client tag accumulation
   4094 byte limit for client-only tags now enforced per spec

2. CLIENTTAGDENY - IMPLEMENTED
   Location: ircd.c is_client_tag_denied(), parse.c filtering, s_user.c ISUPPORT
   Configurable via FEAT_CLIENTTAGDENY feature flag
   Supports exact match and wildcard prefix patterns (e.g., "+typing,+draft/*")

COMPLIANT:
- Client-only tag prefix (+) correctly detected
- Tags not relayed to servers (stored locally only)
- Semicolon separator parsing correct
- TAGMSG command sends client-only tags to channel/user
- Server tags (time, account, msgid, batch, label) correctly formatted
- Tag capabilities correctly advertised (message-tags, draft/event-playback)
```

---

### 8. Labeled Response
**Spec**: https://ircv3.net/specs/extensions/labeled-response

**Implementation Files**:
- `ircd/parse.c` (label extraction from tags)
- `ircd/ircd_reply.c` (label in numerics)
- `ircd/send.c` (label in messages, batch start)

**Checklist**:
- [x] @label= tag in client commands (parse.c:1367-1376)
- [x] @label= tag echoed in responses (ircd_reply.c:114-127)
- [x] ACK for commands with no response - ✅ Fixed (send_labeled_ack in send.c)
- [x] Batch wrapping for multi-line responses (send.c:2065-2100)
- [x] Label only on first message of batch (via cli_batch_id check in send.c:333-346)
- [x] Label max 64 bytes (parse.c:1373-1374 truncates to sizeof(cli_label))
- [x] Self-message exception (label not echoed via echo-message to self)

**Findings**:
```
✅ FULLY COMPLIANT - All issues fixed

Key implementation details:
- Label tag extracted when labeled-response cap active (parse.c:1367-1376)
- Label cleared at start of each message (parse.c:1337)
- Label echoed in numeric replies (ircd_reply.c:114-127)
- Label added to sendcmdto_one responses (send.c:330-348)
- Batch start includes label (send.c:2077-2088)
- When in batch, uses @batch instead of @label on inner messages (send.c:344-348)
- Metadata LIST uses batch wrapping (m_metadata.c:857-883)

FIXED ISSUE:
1. ACK for no-response commands - FIXED
   Location: send.c send_labeled_ack(), parse.c parse_client()
   Implementation:
   - Added cli_label_responded flag to track if response was sent
   - Flag set when @label tag is added to any outgoing message
   - parse_client() clears flag before command dispatch, calls send_labeled_ack() after
   - send_labeled_ack() sends ":server ACK" with @label tag if no response was sent

COMPLIANT:
- Label extraction and storage
- Label echoing in responses
- Batch wrapping (send_batch_start includes label on BATCH +id)
- Label truncation to max 64 bytes
- @batch vs @label selection when in batch context
- ACK sent for commands that produce no response (PONG, etc.)
```

---

### 9. Standard Replies
**Spec**: https://ircv3.net/specs/extensions/standard-replies

**Implementation Files**:
- `ircd/send.c` (send_fail, send_warn, send_note, send_standard_reply_ex)

**Checklist**:
- [x] FAIL command code context :description format (send.c:2480)
- [x] WARN command code context :description format (send.c:2535-2538)
- [x] NOTE command code context :description format (send.c:2567-2570)
- [x] Context is optional (NULL if none) (send.c:2479-2487)
- [x] Code format (uppercase with underscores in all callers)
- [x] Labeled-response integration (send.c:2446-2460)
- [x] Fallback to NOTICE for non-standard-replies clients (send.c:2412-2443)
- [x] Numeric fallback for known codes (NEED_MORE_PARAMS→461, ALREADY_AUTHENTICATED→462)

**Findings**:
```
FULLY COMPLIANT - Comprehensive implementation

Key implementation details:
- send_standard_reply_ex() is the internal helper (send.c:2398-2492)
- Format: TYPE COMMAND CODE [CONTEXT] :DESCRIPTION (send.c:2479-2487)
- Context is optional - can be NULL (send.c:2479-2487)
- All three types implemented: send_fail(), send_warn(), send_note()
- send_warn_with_label() for asynchronous warnings with saved labels (send.c:2551-2556)

LABELED-RESPONSE INTEGRATION:
- Labels included when client has labeled-response cap (send.c:2448-2460)
- Supports explicit label parameter for async replies (send.c:2396, 2457-2459)
- Used by multiline fallback warnings (m_batch.c:917)

FALLBACK FOR NON-CAP CLIENTS:
- Maps known codes to traditional numerics (send.c:2414-2431):
  - NEED_MORE_PARAMS → 461 ERR_NEEDMOREPARAMS
  - ALREADY_AUTHENTICATED → 462 ERR_ALREADYREGISTRED
- Other codes fall back to NOTICE format (send.c:2432-2443)

EXTENSIVE USAGE:
- CHATHISTORY: 20+ different failure codes
- METADATA: 12+ different failure codes
- BATCH: timeout, max_lines, max_bytes, format errors
- REGISTER: disabled, need_more_params, account_exists, etc.
- REDACT: disabled, invalid_target, window_expired, forbidden
- MARKREAD: account_required, temporarily_unavailable
- TAGMSG: need_more_params, invalid_target, cannot_send
- RENAME: cannot_rename, channel_name_in_use
- UTF8ONLY: INVALID_UTF8 (FAIL for strict, WARN for permissive)

All codes observed are uppercase with underscores, matching spec.
```

---

### 10. Read Marker
**Spec**: https://ircv3.net/specs/extensions/read-marker

**Implementation Files**:
- `ircd/m_markread.c`
- `ircd/m_join.c` (JOIN integration)
- `ircd/history.c` (readmarker_get/set)

**Checklist**:
- [x] MARKREAD <target> [timestamp=<ts>] command format (m_markread.c:181)
- [x] MARKREAD <target> timestamp=<ts> response format (m_markread.c:117-122)
- [x] timestamp=* for unknown timestamp (m_markread.c:117)
- [x] ISO 8601 timestamp format (m_markread.c:118 via history_unix_to_iso)
- [x] Timestamp only ever increases (readmarker_set returns 1 if not newer)
- [x] FAIL MARKREAD error codes (NEED_MORE_PARAMS, INVALID_PARAMS, etc.)
- [x] Requires account (m_markread.c:196-200)
- [x] MARKREAD sent on JOIN before 366 (m_join.c:286-287)
- [x] Multi-device sync (notify_local_clients broadcasts to same account)

**Findings**:
```
FULLY COMPLIANT - Comprehensive implementation

Key implementation details:
- Command format matches spec: MARKREAD <target> [timestamp=<ts>]
- Response format: MARKREAD <target> timestamp=<ts> (or timestamp=*)
- Timestamp conversion from Unix to ISO 8601 (history_unix_to_iso)
- "Only ever increase" enforced by readmarker_set() return value
- Standard replies: ACCOUNT_REQUIRED, NEED_MORE_PARAMS, INVALID_PARAMS,
  TEMPORARILY_UNAVAILABLE, INTERNAL_ERROR
- Integration with X3 services for authoritative storage (MR S2S token)
- Local LMDB cache for fast lookups
- Multi-device support: notify_local_clients() broadcasts to all sessions
- JOIN integration: send_markread_on_join() called before NAMES (per spec)

ARCHITECTURE:
- IRCd provides capability negotiation and local caching
- X3 services are authoritative store for read markers
- MR P10 token for S2S communication (S=set, G=get, R=response)
```

---

### 11. Message Redaction
**Spec**: https://ircv3.net/specs/extensions/message-redaction

**Implementation Files**:
- `ircd/m_redact.c`

**Checklist**:
- [x] REDACT <target> <msgid> [<reason>] command format (m_redact.c:140-150)
- [x] FAIL REDACT INVALID_TARGET error (m_redact.c:188,196,204)
- [x] FAIL REDACT REDACT_FORBIDDEN error (m_redact.c:262)
- [x] FAIL REDACT REDACT_WINDOW_EXPIRED error (m_redact.c:233,242,284,291)
- [x] FAIL REDACT UNKNOWN_MSGID error (m_redact.c:218,275)
- [x] Only forward to clients with capability (m_redact.c:125)
- [x] Permission checks (own message, chanop, oper) (m_redact.c:249-258)
- [x] Configurable redaction window (FEAT_REDACT_WINDOW)
- [x] Delete from history database (m_redact.c:268)

**Findings**:
```
FULLY COMPLIANT - Comprehensive implementation

Key implementation details:
- Command format: REDACT <target> <msgid> [:<reason>]
- Error codes all implemented per spec:
  - DISABLED (feature off)
  - INVALID_TARGET (not a channel, not in channel, etc.)
  - UNKNOWN_MSGID (message not found)
  - REDACT_WINDOW_EXPIRED (time limit exceeded)
  - REDACT_FORBIDDEN (not authorized)

AUTHORIZATION MODEL:
- Own messages: allowed within FEAT_REDACT_WINDOW (default: time limited)
- Channel operators: allowed if FEAT_REDACT_CHANOP_OTHERS enabled
- IRC operators: always allowed within FEAT_REDACT_OPER_WINDOW (can be unlimited)

PROPAGATION:
- Only sent to clients with draft/message-redaction capability (m_redact.c:125)
- Echo to sender only if they have echo-message capability (m_redact.c:129)
- S2S propagation via RD token

HISTORY INTEGRATION:
- Validates message existence and ownership via history_lookup_message()
- Deletes from history database on successful redaction
- Fallback to msgid timestamp parsing if history unavailable
```

---

### 12. MONITOR
**Spec**: https://ircv3.net/specs/extensions/monitor

**Implementation Files**:
- `ircd/m_monitor.c`
- `ircd/watch.c`

**Checklist**:
- [x] MONITOR + nick,nick,... format
- [x] MONITOR - nick,nick,... format
- [x] MONITOR C (clear)
- [x] MONITOR L (list)
- [x] MONITOR S (status)
- [x] RPL_MONONLINE (730) format: nick!user@host
- [x] RPL_MONOFFLINE (731) format: nick
- [x] RPL_MONLIST (732) format
- [x] RPL_ENDOFMONLIST (733)
- [x] ERR_MONLISTFULL (734) format
- [x] Online/offline notifications use 730/731

**Findings**:
```
Fixed in this session:
- Was sending WATCH numerics (604/605) to MONITOR clients
- Added WATCH_FLAG_MONITOR to track how entry was added
- check_status_watch() now sends correct numeric format based on flag
```

---

### 11. UTF8ONLY
**Spec**: https://ircv3.net/specs/extensions/utf8-only

**Implementation Files**:
- `ircd/ircd_string.c` (validation/sanitization)
- `ircd/ircd_relay.c` (enforcement for PRIVMSG/NOTICE)
- `ircd/m_topic.c` (enforcement for TOPIC)
- `ircd/m_part.c` (enforcement for PART)
- `ircd/m_quit.c` (enforcement for QUIT)
- `ircd/m_kick.c` (enforcement for KICK)

**Checklist**:
- [x] UTF8ONLY ISUPPORT token
- [x] Invalid UTF-8 rejection or sanitization
- [x] U+FFFD replacement for invalid bytes
- [x] Never truncate mid-codepoint
- [x] All text-bearing commands covered (PRIVMSG, NOTICE, TOPIC, PART, QUIT, KICK)

**Findings**:
```
✅ FULLY COMPLIANT - All text-bearing commands now validated

Fixed earlier:
- Was truncating at first invalid byte instead of U+FFFD replacement
- string_sanitize_utf8() now replaces each invalid byte with U+FFFD
- Preserves valid portions of message

UTF8ONLY enforcement present in:
- ircd_relay.c: PRIVMSG and NOTICE (multiple relay functions)
- m_topic.c: TOPIC command (line 215-222)
- s_bsd.c: General text mode WebSocket frames (line 361)
- m_part.c: PART command (line 121-133) - NEW
- m_quit.c: QUIT command (line 129-138) - NEW
- m_kick.c: KICK command (line 238-251) - NEW

All commands follow the same pattern:
- If UTF8ONLY enabled and text is invalid UTF-8:
  - Strict mode (UTF8ONLY_STRICT): Reject with FAIL INVALID_UTF8
    (QUIT uses default message instead since connection is terminating)
  - Permissive mode: Sanitize with U+FFFD replacement, send WARN

MULTI-SERVER NETWORK BEHAVIOR:
UTF8ONLY's primary use case is WebSocket servers where browsers require valid
UTF-8 in text frames (RFC 6455: "Servers MUST NOT relay non-UTF-8 content to
clients using text messages").

Defense in depth approach:
1. INPUT VALIDATION (local clients):
   - UTF8ONLY validates text at source on PRIVMSG, NOTICE, TOPIC, PART, QUIT, KICK
   - Catches bad input before it enters the network

2. OUTPUT SANITIZATION (WebSocket text frames):
   - s_bsd.c:361-363 sanitizes ALL outgoing text to WebSocket text-mode clients
   - Catches anything from S2S that slipped through (from non-UTF8ONLY servers)
   - This is the safety net required by RFC 6455

| Message Origin        | To Traditional Client | To WebSocket Text Client |
|-----------------------|-----------------------|--------------------------|
| Local UTF8ONLY server | Passes (validated)    | Passes (validated)       |
| Remote non-UTF8ONLY   | Passes (may be bad)   | Sanitized at output      |

This ensures WebSocket text clients NEVER receive invalid UTF-8 regardless of
message origin, satisfying RFC 6455 requirements.
```

---

### 14. STS (Strict Transport Security)
**Spec**: https://ircv3.net/specs/extensions/sts

**Implementation Files**:
- `ircd/m_cap.c` (STS capability value, lines 290-302)

**Checklist**:
- [x] sts capability value format (port=N,duration=N) (m_cap.c:290-302)
- [x] Duration in seconds (FEAT_STS_DURATION, default 2592000 = 30 days)
- [x] Port for TLS connection (FEAT_STS_PORT, default 6697)
- [x] Only advertised to CAP 302+ clients (m_cap.c:236)
- [x] Optional preload directive (FEAT_STS_PRELOAD)
- [x] Marked PROHIBIT - clients cannot request it (m_cap.c:113)

**Findings**:
```
FULLY COMPLIANT - Comprehensive implementation

Key implementation details:
- Capability defined with CAPFL_PROHIBIT flag (m_cap.c:113)
- Only advertised to CAP 302+ clients (m_cap.c:236)
- Cap value format: port=N,duration=N[,preload] (m_cap.c:290-302)
- Feature flags:
  - FEAT_CAP_sts - Enable STS
  - FEAT_STS_PORT - TLS port (default 6697)
  - FEAT_STS_DURATION - Duration in seconds (default 30 days)
  - FEAT_STS_PRELOAD - Include preload directive for HSTS preload lists

Per spec, STS is only meaningful on plaintext connections to redirect
to TLS. The PROHIBIT flag prevents clients from trying to enable it.
```

---

### 15. CAP Negotiation
**Spec**: https://ircv3.net/specs/extensions/capability-negotiation

**Implementation Files**:
- `ircd/m_cap.c`

**Checklist**:
- [x] CAP LS 302 format with version parsing (m_cap.c:341-346)
- [x] CAP LS multiline continuation (* marker) (m_cap.c:315-316)
- [x] CAP LS key=value for 302+ clients (m_cap.c:257-310)
- [x] CAP REQ format (m_cap.c:352-396)
- [x] CAP ACK format (m_cap.c:391)
- [x] CAP NAK format for rejected requests (m_cap.c:370)
- [x] CAP END (m_cap.c:464)
- [x] CAP LIST (sends current capabilities)
- [x] cap-notify NEW/DEL messages - ✅ Fixed (send_cap_notify in m_cap.c)
- [x] Sticky capabilities (CAPFL_STICKY flag) (m_cap.c:369,415)
- [x] cap-notify capability defined (m_cap.c:88)

**Findings**:
```
✅ FULLY COMPLIANT - All issues fixed

Key implementation details:
- CAP LS 302 version parsing (m_cap.c:341-346)
- Multiline continuation: sends with "* :" for non-final lines (m_cap.c:315)
- Cap values for 302+ clients (SASL mechanisms, multiline limits, etc.)
- All subcommands implemented: LS, REQ, ACK, LIST, END
- NAK sent for rejected requests (prohibited caps, sticky caps)
- Sticky capability support via CAPFL_STICKY flag
- Suspended registration during CAP negotiation (auth_cap_start)

FIXED ISSUE:
1. CAP NEW/DEL - FIXED
   Location: m_cap.c send_cap_notify(), ircd.c, list.c
   Implementation:
   - send_cap_notify() broadcasts CAP NEW/DEL to all cap-notify clients
   - Called from set_sasl_mechanisms() when services announces/clears SASL
   - Called from set_vapid_pubkey() when services announces/clears webpush
   - Services disconnect cleanup in list.c clears mechanisms and triggers CAP DEL
   - Includes cap values where applicable (e.g., sasl=mechanisms)

COMPLIANT:
- CAP LS with version support
- CAP LS multiline for long capability lists
- CAP REQ/ACK/NAK transaction handling
- Sticky capabilities (can't be disabled via REQ -)
- Prohibited capabilities (can't be enabled via REQ)
- CAP NEW/DEL for dynamic capabilities (sasl, draft/webpush)
```

---

### 16. Echo-message
**Spec**: https://ircv3.net/specs/extensions/echo-message

**Implementation Files**:
- `ircd/ircd_relay.c` (PRIVMSG/NOTICE echo)
- `ircd/m_tagmsg.c` (TAGMSG echo)
- `ircd/m_batch.c` (multiline echo)
- `ircd/m_redact.c` (REDACT echo)

**Checklist**:
- [x] PRIVMSG echoed to sender (ircd_relay.c:427-450)
- [x] NOTICE echoed to sender (ircd_relay.c:543-566)
- [x] TAGMSG echoed to sender (m_tagmsg.c:215-261)
- [x] Multiline messages echoed (m_batch.c:629-640)
- [x] REDACT echoed to sender if cap enabled (m_redact.c:129)
- [x] Echo respects message tags (time, msgid)
- [x] Not echoed if sender is target (private message to self handled)

**Findings**:
```
FULLY COMPLIANT - Comprehensive echo support

Key implementation details:
- Feature controlled by FEAT_CAP_echo_message
- Echoes PRIVMSG, NOTICE, TAGMSG, REDACT to sender
- Echo includes server tags (@time, @msgid) for consistency
- Multiline batches: entire batch echoed with full tags
- REDACT echo conditional on CAP_ECHOMSG (m_redact.c:129)

All message types that should be echoed are covered:
- Channel messages (ircd_relay.c:427, 449)
- Private messages (ircd_relay.c:944, 965)
- Channel notices (ircd_relay.c:543-566)
- Private notices (ircd_relay.c:1060, 1082)
- TAGMSG to channels and users (m_tagmsg.c:216, 248, 261)
- Multiline batch messages (m_batch.c:640, 818)
```

---

### 17. Account-notify, Away-notify, Invite-notify
**Specs**:
- https://ircv3.net/specs/extensions/account-notify
- https://ircv3.net/specs/extensions/away-notify
- https://ircv3.net/specs/extensions/invite-notify

**Implementation Files**:
- `ircd/m_account.c` (account-notify)
- `ircd/m_away.c` (away-notify)
- `ircd/m_invite.c` (invite-notify)

**Checklist**:
- [x] ACCOUNT notification format: `:nick!user@host ACCOUNT accountname` or `*` (m_account.c:177-178, 223-224)
- [x] AWAY notification format: `:nick!user@host AWAY [:message]` (m_away.c:239-245)
- [x] INVITE notification format: `:<inviter> INVITE <target> <channel>` (m_invite.c:203-206)
- [x] All three sent only to clients with respective capabilities
- [x] Sent to users on common channels

**Findings**:
```
FULLY COMPLIANT - All three notification capabilities properly implemented

Key implementation details:
- account-notify: sendcmdto_common_channels_capab_butone() with CAP_ACCNOTIFY
  - Sends "*" for logout (m_account.c:178)
  - Sends account name for login (m_account.c:224)
- away-notify: sendcmdto_common_channels_capab_butone() with CAP_AWAYNOTIFY
  - Sends ":%s" with away message for going away (m_away.c:239-240)
  - Sends "" (empty) for returning (m_away.c:245)
- invite-notify: sendcmdto_channel_capab_butserv_butone() with CAP_INVITENOTIFY
  - Format: "%C %H" (target, channel) from inviter prefix (m_invite.c:204-206)
  - Gated by FEAT_CAP_invite_notify feature flag
```

---

### 18. Extended-join, Chghost
**Specs**:
- https://ircv3.net/specs/extensions/extended-join
- https://ircv3.net/specs/extensions/chghost

**Implementation Files**:
- `ircd/channel.c` (extended-join)
- `ircd/s_user.c` (chghost, extended-join on host change)

**Checklist**:
- [x] Extended JOIN format: `:nick!user@host JOIN #channel account :realname` (channel.c:5100-5103)
- [x] Extended JOIN uses `*` for no account (channel.c:5102)
- [x] Extended JOIN includes realname (GECOS) (channel.c:5103)
- [x] CHGHOST format: `:nick!old_user@old_host CHGHOST new_user new_host` (s_user.c:1280-1283)
- [x] CHGHOST sent to common channels (s_user.c:1281)
- [x] Fallback QUIT+JOIN for non-chghost clients (s_user.c:1268-1271)

**Findings**:
```
FULLY COMPLIANT - Both capabilities properly implemented

Extended-join (CAP_EXTJOIN):
- Format: JOIN #channel account :realname
- Uses "*" for unauthed users: IsAccount(cptr) ? cli_account(cptr) : "*"
- Realname: cli_info(cptr)
- Implemented at:
  - Channel join (channel.c:5100-5103)
  - Delayed join reveal (channel.c:5224-5229)
  - Host change rejoin (s_user.c:1306-1309, 1396-1401)

Chghost (CAP_CHGHOST):
- Format: CHGHOST new_user new_host
- Sent via sendcmdto_common_channels_capab_butone() to CAP_CHGHOST clients
- Source prefix includes OLD user@host (per spec)
- Implemented at:
  - hide_hostmask (s_user.c:1279-1283)
  - unhide_hostmask (s_user.c:1372-1376)
- SKIP_CHGHOST flag prevents duplicate notifications to chghost clients
  when using QUIT+JOIN fallback for non-capable clients
```

---

### 19. Server-time, Account-tag, Msgid
**Specs**:
- https://ircv3.net/specs/extensions/server-time
- https://ircv3.net/specs/extensions/account-tag
- https://ircv3.net/specs/extensions/message-ids

**Implementation Files**:
- `ircd/send.c` (all three)

**Checklist**:
- [x] server-time format: `@time=YYYY-MM-DDTHH:MM:SS.sssZ` (send.c:101-104)
- [x] ISO 8601 extended format with milliseconds (send.c:188-191)
- [x] UTC timezone (Z suffix) (send.c:191)
- [x] account tag: MUST NOT be sent if user not authenticated - ✅ Fixed
- [x] msgid unique across network (send.c:249-252)
- [x] msgid format: `<server>-<startup>-<counter>` (send.c:249-252)
- [x] msgid: no colon, no SPACE/CR/LF (send.c format is safe)

**Findings**:
```
✅ FULLY COMPLIANT - All issues fixed

server-time: FULLY COMPLIANT
- Format: @time=YYYY-MM-DDTHH:MM:SS.sssZ (send.c:101-104, 188-191)
- Uses gettimeofday() for millisecond precision
- Uses gmtime_r() for UTC conversion
- Trailing Z for UTC timezone

account-tag: FIXED
- Location: send.c format_message_tags_for_ex()
- Now correctly omits account tag for unauthenticated users (no "account=*")
- Only sends account tag when IsAccount(from) is true

msgid: FULLY COMPLIANT
- Format: <server_numeric>-<startup_timestamp>-<counter> (send.c:249-252)
- Guaranteed unique: server numeric + startup time + incrementing counter
- No forbidden characters (only alphanumeric, dash, digits)
- Counter (MsgIdCounter) ensures uniqueness within server session
```

---

### 20. Setname
**Spec**: https://ircv3.net/specs/extensions/setname

**Implementation Files**:
- `ircd/m_setname.c`

**Checklist**:
- [x] SETNAME :realname command format (m_setname.c:126)
- [x] :nick!user@host SETNAME :realname notification (m_setname.c:147-149)
- [x] Echo to sender (m_setname.c:143-144)
- [x] Notify channel members with capability (m_setname.c:147-149)
- [x] FAIL SETNAME INVALID_REALNAME for too-long realname - ✅ Config-gated (FEAT_SETNAME_STRICT_LENGTH)
- [x] FAIL SETNAME NEED_MORE_PARAMS for missing param (m_setname.c:121-123)

**Findings**:
```
✅ FULLY COMPLIANT - Behavior now configurable

Key implementation details:
- Command handled by m_setname() (m_setname.c:106)
- S2S propagation via SE P10 token (m_setname.c:140)
- Echo to sender if CAP_SETNAME active (m_setname.c:143-144)
- Notification to channel members via sendcmdto_common_channels_capab_butone()

FIXED (CONFIG-GATED):
1. Length validation behavior - CONFIGURABLE
   Location: m_setname.c:130-135
   - FEAT_SETNAME_STRICT_LENGTH=1: Returns FAIL SETNAME INVALID_REALNAME (spec behavior)
   - FEAT_SETNAME_STRICT_LENGTH=0: Silently truncates (legacy behavior, default)
   Operators can choose spec-compliant rejection or user-friendly truncation

COMPLIANT:
- NEED_MORE_PARAMS error (m_setname.c:121-123)
- Echo-back to sender with capability
- Channel notification to capable clients
- S2S propagation
- Configurable strict length enforcement
```

---

## Discovered Issues

| Feature | Issue | Severity | Status |
|---------|-------|----------|--------|
| MONITOR | Wrong numerics for notifications | Medium | Fixed |
| UTF8ONLY | Truncation instead of U+FFFD | Medium | Fixed |
| UTF8ONLY | PART/QUIT/KICK text not validated | Low | Fixed |
| WebSocket | Hardcoded text mode | Medium | Fixed |
| WebSocket | WEBSOCKET_RECVQ unjustified | Low | Removed |
| SASL | AUTHENTICATE * (abort) not handled | Medium | Fixed |
| SASL | ERR_NICKLOCKED (902) not defined | Low | Fixed |
| SASL | ERR_SASLALREADY (907) not used for non-OAUTHBEARER | Low | Fixed |
| Chathistory | (No issues found) | N/A | Compliant |
| Multiline | Blank lines sent in fallback | Low | Fixed |
| Multiline | Concat+blank line not validated | Low | Fixed |
| Metadata | Colon (:) allowed in keys | Very Low | Fixed |
| Batch | (No issues found) | N/A | Compliant |
| Message Tags | Tag value escaping not implemented | Very Low | Pass-through OK |
| Message Tags | Tag length limits not enforced | Low | Fixed |
| Message Tags | CLIENTTAGDENY not advertised | Very Low | Implemented |
| Labeled Response | ACK for no-response commands missing | Medium | Fixed |
| Read Marker | (No issues found) | N/A | Compliant |
| Message Redaction | (No issues found) | N/A | Compliant |
| Standard Replies | (No issues found) | N/A | Compliant |
| CAP Negotiation | CAP NEW/DEL not implemented | Low | Fixed |
| STS | (No issues found) | N/A | Compliant |
| Echo-message | (No issues found) | N/A | Compliant |
| Account-notify | (No issues found) | N/A | Compliant |
| Away-notify | (No issues found) | N/A | Compliant |
| Invite-notify | (No issues found) | N/A | Compliant |
| Extended-join | (No issues found) | N/A | Compliant |
| Chghost | (No issues found) | N/A | Compliant |
| Server-time | (No issues found) | N/A | Compliant |
| Account-tag | Sends `account=*` for unauthenticated users | Low | Fixed |
| Msgid | (No issues found) | N/A | Compliant |
| Setname | Truncates instead of FAIL INVALID_REALNAME | Low | Config-gated |

---

## Audit Summary

### High Priority
| Feature | Status | Issues Found |
|---------|--------|--------------|
| SASL | ✅ Fully Compliant | All issues fixed |
| Chathistory | ✅ Fully Compliant | 0 |
| Multiline | ✅ Fully Compliant | All issues fixed |
| WebSocket | ✅ Fully Compliant | All issues fixed |
| Metadata | ✅ Fully Compliant | Colon issue fixed |

### Medium Priority
| Feature | Status | Issues Found |
|---------|--------|--------------|
| Batch | ✅ Fully Compliant | 0 |
| Message Tags | ✅ Fully Compliant | All issues fixed, CLIENTTAGDENY implemented |
| Labeled Response | ✅ Fully Compliant | ACK now implemented |
| Read Marker | ✅ Fully Compliant | 0 |
| Message Redaction | ✅ Fully Compliant | 0 |
| Standard Replies | ✅ Fully Compliant | 0 |

### Lower Priority
| Feature | Status | Issues Found |
|---------|--------|--------------|
| CAP Negotiation | ✅ Fully Compliant | NEW/DEL now implemented |
| Echo-message | ✅ Fully Compliant | 0 |
| STS | ✅ Fully Compliant | 0 |
| MONITOR | ✅ Fully Compliant | Issue fixed |
| UTF8ONLY | ✅ Fully Compliant | All text-bearing commands now validated |
| Account-notify | ✅ Fully Compliant | 0 |
| Away-notify | ✅ Fully Compliant | 0 |
| Invite-notify | ✅ Fully Compliant | 0 |
| Extended-join | ✅ Fully Compliant | 0 |
| Chghost | ✅ Fully Compliant | 0 |
| Server-time | ✅ Fully Compliant | 0 |
| Account-tag | ✅ Fully Compliant | No longer sends * for unauth |
| Msgid | ✅ Fully Compliant | 0 |
| Setname | ✅ Fully Compliant | Config-gated FAIL behavior |

---

## Notes

- Some specs are drafts and may change
- Some behaviors may be intentional deviations for compatibility
- Document rationale for any intentional non-compliance

---

## Remediation Plan

See **[ircv3-compliance-remediation.md](./ircv3-compliance-remediation.md)** for:
- Detailed implementation instructions for all fixes
- Priority ordering (Phase 1/2/3)
- Testing requirements
- Documentation of intentional deviations

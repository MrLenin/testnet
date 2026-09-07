# Paste-port WebSocket upgrade — single HTTPS front port (design)

**Status:** SHIPPED 2026-08-28 — nefarious `de3756f` (ircv3.2-hardening / evilnet ircv3.2-upgrade). Live probe (paste GET + wss:// on one port) deferred to next bed bring-up.
**Goal:** one TLS port serves both paste GETs and `wss://` IRC — one cert,
one firewall hole, indistinguishable from a plain web server from outside.

## Current state (verified in tree, ircv3.2-hardening @ 7a47da1)

- Accept routing (`listener.c` ~578): `listener_paste` → `paste_accept_connection(fd)`
  — note the **listener pointer is dropped**; paste conns have no back-ref.
- Paste side (`paste_listener.c`): own `struct paste_conn` (fd, SSL*, Socket,
  Timer, request[8k] accumulator), own SSL_accept + SSL_pending drain
  (`paste_drain_read`), request parsed at `\r\n\r\n`, **GET-only**, serve →
  close. Not Client/Connection objects.
- Conf (`ircd_parser.y` ~1013): `paste` + `websocket` in one Port block is a
  **parse error** today ("cannot combine paste with websocket"). Paste
  requires `ssl = yes`.
- IRC side: a WS upgrade is consumed by `websocket_handshake_feed`
  (per-Client accumulator, runs once the blank line arrives) on a Client in
  `IsWSNeedHandshake` state; `add_connection(listener, fd, ssl)` builds a
  Client on an already-accepted SSL fd (this is exactly what
  `ssl_add_connection` calls after its own SSL_new/set_fd).
- Cert-request: paste ports already run `SSL_VERIFY_NONE` (the workaround
  PR #101 generalized), so the Chromium WS cert-cancel problem is pre-solved
  on this port. #101's ALPN ex_data marking applies only to the main server
  ctx — not needed here since VERIFY_NONE is unconditional.

## Design

Route by request, not by port: on a paste port, an HTTP request that carries
`Upgrade: websocket` is an IRC client; anything else is a paste fetch.

1. **Conf:** lift the parser veto for exactly `paste = yes; websocket = yes;`
   (both flags on the block = "paste port that accepts WS upgrades").
   `websocket = autodetect` + paste stays an error (autodetect's 3-byte
   sniff is meaningless on an HTTP-only port). Default behavior of existing
   paste blocks is unchanged.
2. **Stash the listener:** `paste_accept_connection(fd)` →
   `paste_accept_connection(listener, fd)`; store `struct Listener *` in
   `paste_conn`. (Needed for `add_connection` and for the class/IPcheck
   attach to work exactly as on a normal WS port.)
3. **Detect at header-parse time** (`paste_handle_request`, before the
   GET-path dispatch): if the listener has `LISTEN_WEBSOCKET` and the
   headers contain `Upgrade: websocket` (case-insensitive token match, same
   test `websocket_handshake` uses) → promote instead of serve.
4. **Promote** (`paste_promote_to_client(conn)`):
   - detach fd+SSL from the paste_conn: `socket_del` its Socket, kill its
     Timer, unlink from `paste_conn_list` **without** SSL_free/close;
   - `add_connection(conn->listener, conn->fd, conn->ssl)` → normal
     unknown-Client path: IPcheck, class attach, auth pipeline — everything
     a `websocket = yes` port does;
   - mark the new Client `IsWSNeedHandshake` (the listener's
     `LISTEN_WEBSOCKET` flag makes `add_connection` do this the same way it
     does for dedicated WS ports — verify; else set explicitly);
   - replay `conn->request` (the already-buffered upgrade request bytes)
     through `websocket_handshake_feed(cptr, ...)` so the handshake
     completes without waiting for a fresh read event (the request is
     usually complete in the buffer at detection time — the feed returns
     success immediately and the 101 goes out);
   - free the husk paste_conn.
5. **Origin policy:** the shared `websocket_handshake` path already applies
   `WEBSOCKET_ORIGIN` validation and the WS mark (`cli_wsorigin`) — both
   work unchanged on the promoted connection. ws-text default (b200b7d)
   also inherited.

## What deliberately does NOT change

- Paste-only ports (no `websocket = yes`): byte-identical behavior,
  upgrade requests keep getting 405/404.
- Dedicated `websocket = yes` IRC ports: untouched; this is additive.
- No HTTP surface growth: the only non-paste request honored is the
  upgrade; everything else still 404/405s.

## Risks / open questions

- **IPcheck timing:** normal client path IPchecks at accept; here it runs at
  promote (a few ms later, after TLS + one HTTP read). A paste-side
  pre-promote flood is bounded by the paste conn cap + 8k request cap +
  paste timeout, so exposure is small. Acceptable.
- **`add_connection` reentry assumptions:** it expects a freshly-accepted
  socket; here the fd has consumed TLS handshake + one request. Audit its
  IP/sockhost derivation (getpeername-based, fine) and the listener
  ref-counting (`listener->ref_count`) so the promote takes a proper ref.
- **sendq/recvq class accounting** starts at promote — fine (identical to a
  slow TLS handshake).
- **Does `add_connection` auto-set WS-handshake state from the listener
  flag?** (s_bsd.c — check at build time; if it keys off
  `listener_websocket()`, step 4's explicit mark is redundant.)

## Size estimate

~120-150 lines: parser (lift veto) + paste_conn listener field + detect
branch + promote function. No new subsystem. Gate: build + cmocka + live
probe (curl paste GET and a wss:// client against the same port).

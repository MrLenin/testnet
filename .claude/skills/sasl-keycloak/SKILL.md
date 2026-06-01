---
name: sasl-keycloak
description: Nefarious SASL and Keycloak reference — local SASL via Keycloak ROPC through libkc, three-tier AUTHENTICATE dispatch (local Keycloak / IAuth / P10 relay), the mechanism support matrix, cross-server cache coherence (CI token), and Keycloak REST gotchas. Use when working on SASL authentication, the libkc integration, or Keycloak-backed accounts.
---

# SASL / Keycloak Skill

Reference for Nefarious's local SASL path (direct Keycloak auth via libkc) and its three-tier dispatch. For the P10 SASL relay wire format see `p10-protocol.md`; for libkc's event integration see `nefarious-codebase.md`.

## Local SASL (Keycloak Direct)

- `sasl_auth.c` / `sasl_auth.h` — local SASL PLAIN via a Keycloak ROPC grant through libkc.
- Three-tier dispatch in `m_authenticate.c`: **local Keycloak → IAuth → P10 relay**.
- `sasl_local_available()` checks `sasl_local_initialized && FEAT_SASL_LOCAL && kc_sasl_healthy`.
- Health tracking via `sasl_health_cb` — toggles CAP NEW/DEL for the `sasl` capability.
- libkc HTTP detail (lives in the external libkc library, not this repo): `CURLOPT_POSTFIELDSIZE` must be set **before** `CURLOPT_COPYPOSTFIELDS` (per curl docs). Not verifiable from the Nefarious tree.

## Mechanism Support

Which mechanisms get *advertised* is gated by `FEAT_SASL_LOCAL_MECHANISMS` (default `"PLAIN,OAUTHBEARER"`); the off-by-default handlers all exist in `sasl_auth.c`.

- **PLAIN** — SASL_LOCAL, iauthd-ts, and X3 relay. Advertised by default.
- **OAUTHBEARER** — SASL_LOCAL only. Advertised by default.
- **EXTERNAL** — SASL_LOCAL has a real handler (`sasl_handle_external`): matches the TLS client-cert fingerprint `cli_sslclifp()` against Keycloak's `x509_fingerprints` attribute. Also via X3 relay. iauthd-ts does NOT support it. Off by default.
- **SCRAM-SHA-256** — fully implemented in SASL_LOCAL (`sasl_scram_*`, HMAC-SHA256 ClientProof). Off by default.
- **ECDSA-NIST256P-CHALLENGE** — fully implemented in SASL_LOCAL (`sasl_handle_ecdsa`, challenge + `EVP_DigestVerify`). Off by default.

## Caches & Cross-Server Coherence

- **Phase 4a/4b** (committed): auth caches (SipHash-2-4 negative/positive), webhook handler with deauth via `AC U`.
- **Phase 4c** (committed to submodule): CI token for cross-server cache coherence.
- **Webhook**: a single *inbound* HTTP listener (`sasl_webhook_init(port, secret)` on top of libkc's `kc_webhook` server) receiving Keycloak events (password change / delete / disable / logout). Configured by `FEAT_WEBHOOK_PORT` + `FEAT_WEBHOOK_SECRET` — one port, no URL list, no outbound delivery.
- **CI token**: `CACHEINVAL` / `CI` — a P10 token, silently ignored by legacy servers. Handled by `ms_cacheinval()` in `sasl_webhook.c`.

## Transition Architecture

Read-only LDAP federation short-term (no X3 changes); Keycloak as authority long-term.

## Operational Notes

- Keycloak is **not** slow — test timeouts are usually test infrastructure, not Keycloak latency (avg ~45ms; rare ~1s outlier). Use generous timeouts (10s+ for SASL flows) and `retry: 2` for KC-dependent tests.
- Keycloak `PUT` requires the FULL user representation; omitted fields get cleared. GET → merge → PUT, and update the `kc_user_repr_cache` AFTER merging (not before). Strip `credentials` from cached reprs — including them in a PUT ADDS a credential rather than replacing, causing duplicate passwords.
- **Async race on concurrent user updates**: when two async ops update the same user (e.g. email + attribute), the second op can read a cache populated by the first op's GET before the first op's PUT lands — its merge is against stale state, and its PUT overwrites the first op's changes. Mitigation: update the cache **immediately after merging** your changes (so the next op sees the new state), not after the PUT returns.

## Open Blocker (kept in memory, not here)

The testnet ircd.conf files hardcode `KEYCLOAK_CLIENT_SECRET` and `WEBHOOK_SECRET`; these need templating/externalization before the Phase 4c testnet config can be committed. Tracked in personal memory because it concerns unshipped config + live secrets — do not paste secret values into this skill or any committed file.

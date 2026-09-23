# Keycloak certfp grant and credential scoping (design, 2026-09-23)

**Decision (user, 2026-09-23):** the ircd stops holding Keycloak admin credentials for
its login paths. Certificate login (SASL EXTERNAL) moves to a purpose-specific grant
type implemented as a Keycloak extension in the SPI jar we already ship
(`keycloak-webhook-spi`). The everyday login path runs on a client with no
administrative role at all. This is the post-X3 direction: user certificates are
user-provided (AfterNET runs no CA), so a fingerprint-to-account mapping must exist
somewhere, and Keycloak keeps it.

Related: `account-timestamp-authority-2026-09.md` (step 5: the id travels in the ID
token, which this design extends to certificate logins);
`plan-step5-wire-keycloak-id-2026-09-22.md`; memory `keycloak-credential-scoping`.

## Today

The ircd's service account on the bed holds `realm-admin` (every realm-management
role, including `impersonation`, `manage-realm`, `manage-clients`), granted by
`scripts/setup-keycloak.sh:417-441` "for full access". libkc holds one
`client_id`/`client_secret` (`x3-services`) and uses it for everything:

| ircd path | libkc call | credential it needs |
|---|---|---|
| PLAIN | `kc_user_verify_password` (password grant) | a client secret, no role; works on a public client |
| OAUTHBEARER | `kc_jwt_validate_local` (JWKS) / `kc_token_introspect` fallback | none / a client secret, no role |
| health probe | `kc_token_ensure` at init, on the retry timer, periodically | none needed: JWKS or the discovery document answers the same question |
| EXTERNAL | `kc_user_search("x509_fingerprints:<fp>", exact)` | `query-users` suffices (measured below); `realm-admin` today |
| SCRAM-SHA-256, ECDSA | `kc_user_get` for the stored verifier before any token exists | `view-users` today; both off by default, the bed enables SCRAM |
| /REGISTER | `kc_user_get` (twice), `kc_user_create_full`, `kc_user_send_verify_email` | `manage-users` |
| unused in the ircd | delete, update, set password, get-by-id, groups | none; dead surface |

The inbound webhook, cache invalidation and web push use no Keycloak credential.

## Minimum privileges today (measured on the bed, Keycloak 26.4.7, 2026-09-23)

A throwaway service-account client was granted one realm-management role at a time and
exercised every admin call the ircd makes:

| role | search by name (`kc_user_get`) | search by attribute (EXTERNAL) | get by id | create (/REGISTER) | send verify email |
|---|---|---|---|---|---|
| none | 403 | 403 | 403 | 403 | 403 |
| `query-users` | 200, brief representation (no attributes) | 200 | 403 | 403 | 403 |
| `view-users` (= `query-users` + `query-groups`) | 200 with attributes | 200 | 200 | 403 | 403 |
| `manage-users` (not a composite; the evaluator lets it read users) | 200 with attributes | 200 | 200 | 201 | authorised (the bed's 500 is missing SMTP) |

So, by what is switched on:

- **EXTERNAL only** (SCRAM/ECDSA off, /REGISTER off): `query-users`. The fingerprint
  search and the brief representation carry everything EXTERNAL uses (`id`, `username`,
  `createdTimestamp`).
- **SCRAM-SHA-256 or ECDSA on:** `view-users`, because the verifiers are user attributes
  and `query-users` returns brief representations without them.
- **/REGISTER on:** `manage-users`, which also covers every read. It can still create,
  delete and reset any user in the realm; it cannot impersonate, manage clients or the
  realm. That is the interim production grant, and the reason /REGISTER is the next
  thing to move off the admin API.

Production should grant exactly the row it needs and nothing above it; `realm-admin`
is never required.

## The certfp grant

Keycloak's token endpoint is pluggable: `org.keycloak.protocol.oidc.grants.OAuth2GrantType`
and `OAuth2GrantTypeFactory` (present since 24, in the 26.x line), registered through
`META-INF/services/org.keycloak.protocol.oidc.grants.OAuth2GrantTypeFactory`. The
factory's id is the `grant_type` value; `process(Context)` returns the token response;
`getEventType()` names the event Keycloak records. The built-in password grant
(`ResourceOwnerPasswordCredentialsGrantType`) is the template: it authenticates,
creates the user session and client session, and issues the tokens through
`TokenManager`.

**Request** (token endpoint, form-encoded, from a confidential client):

```
grant_type=urn:afternet:params:oauth:grant-type:certfp
client_id=irc-login&client_secret=...
fingerprint=<hex, exactly as the ircd's cli_sslclifp() presents it>
scope=openid
```

**Processing:**
1. The client must be confidential and on the grant's allow-list (provider config
   `allowedClients`, set in the server configuration, so only a Keycloak operator can
   widen it). Anyone else gets `unauthorized_client`.
2. Resolve `x509_fingerprints` = fingerprint through the user provider's attribute
   search (the multi-valued attribute the ircd searches today). Exactly one user, or
   `invalid_grant`; two users with the same fingerprint is refused, as the ircd refuses
   it today.
3. Refuse a disabled user, a temporarily locked user (brute-force protection) and a
   user with a pending required action, with the same `error_description` shapes the
   password grant uses, so the ircd's `kc_classify_grant_error` keeps working.
4. Issue access, refresh and ID tokens with `openid`; record a LOGIN event with the
   grant type and the fingerprint in its details, so the audit trail and the webhook
   see it.

**Result on the ircd:** EXTERNAL becomes what PLAIN is after step 5. The ID token's
`sub` gives the Keycloak id, `created_at` gives the timestamp, and no lookup happens.
The ircd's credential can say "this fingerprint was presented" and nothing else.

Certificates stay where they are: users manage them in the account console; the
attribute stays the source of truth.

## libkc: two credentials

- `struct kc_config` gains a login pair and an admin pair. The password grant, the
  certfp grant and introspection use the login pair; `kc_token_ensure` (the admin
  token) uses the admin pair and is fetched only when an admin call needs it.
- New `kc_user_verify_certfp(fingerprint, kc_token_cb, data)` beside
  `kc_user_verify_password`, same callback shape, same `scope=openid`.
- `sasl_auth.c`: EXTERNAL calls `kc_user_verify_certfp` and reuses the PLAIN
  callback's id extraction; `kc_user_search` loses its last caller.
- The health probe primes JWKS (already done at init) and treats that as the
  reachability signal; `kc_token_ensure` leaves init and the retry timer.
- Config: `Keycloak { login_client_id; login_client_secret; admin_client_id;
  admin_client_secret; }`, with the old `client_id`/`client_secret` read as the admin
  pair for one release.

## The bed and the remaining admin paths

- `scripts/setup-keycloak.sh`: create `irc-login` (confidential, direct access grants
  on, no service account) and put it on the grant's allow-list; narrow `x3-services`'s
  service account from `realm-admin` to `manage-users` (not a composite, but Keycloak's
  evaluator lets it read users) for as long as /REGISTER stays in-band. That is the interim credential; the goal is
  none.
- **SCRAM-SHA-256 and ECDSA:** retire. They need the stored verifier before any token
  exists, which no non-admin path can supply. PLAIN over TLS and OAUTHBEARER cover the
  need. The SPI's `ScramCredentialProvider` and `ScramPasswordPolicyProvider` go with
  them. Sequence: drop them from the bed's `SASL_LOCAL_MECHANISMS`, then remove the code.
- **/REGISTER:** decide between Keycloak's own registration page (the ircd hands out
  the link; zero credential) and an SPI endpoint "create IRC user" behind its own role
  that enforces our naming and rate rules. Until decided, `manage-users` stays.
- Keycloak 26's fine-grained admin permissions may confine `manage-users` to a group of
  IRC-registered users; not verified.

## Steps

1. Bed: narrow the service account in `setup-keycloak.sh` and on the live realm to
   the measured row (`manage-users` while /REGISTER stays in-band); confirm EXTERNAL,
   SCRAM and /REGISTER still work.
2. SPI: the certfp grant, with unit tests (the SPI has none today) for: unknown
   fingerprint, two users, disabled user, pending required action, a client not on the
   allow-list, and the happy path returning an ID token with `sub`.
3. libkc + ircd: the two credentials, `kc_user_verify_certfp`, EXTERNAL rewired,
   health via JWKS. Bed test with the existing `CertClient` helper: a certificate login
   is introduced with `+r account:ts:id` (the wire test's regex) and X3 binds it.
4. Retire SCRAM and ECDSA.
5. Decide /REGISTER; then remove the admin pair from the ircd entirely if the page
   wins.

## Open questions

- The exact fingerprint format in `x509_fingerprints` versus `cli_sslclifp()` (hex,
  case, separators): match the ircd's current query string.
- Whether the grant-type SPI is stable enough across 26.x point releases to build
  against `keycloak-server-spi-private` (the webhook SPI already does).
- Whether `irc-login` should be public for the password grant (it is public today as
  `irc-client` for the tests); the certfp grant needs a confidential client, so one
  confidential login client for both is simplest.

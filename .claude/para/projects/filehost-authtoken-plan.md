# FILEHOST via authtoken — plan (2026-09-10)

Decision (user, 2026-09-10): no local storage or serving in the ircd; the upload host is
`paste.boxlabs.uk` (boxlabss/PASTE, PHP, JSON API `api.php` with per-user `X-API-Key`; text
pastes today, an image/video component exists but is not fully integrated yet); auth via the
**authtoken** draft so IRC passwords never transit to the HTTP side.

## Drafts (ircv3-specifications PRs, texts read 2026-09-10)
- #562 `draft/FILEHOST=<https url>` ISUPPORT; client POSTs the file (Content-Type,
  Content-Disposition, Content-Length) with `Authorization: Basic` (SASL PLAIN) or `Bearer`
  (OAUTHBEARER); server answers 201 + Location, must serve GET/HEAD, must accept OPTIONS
  (may send Accept-Post). goguma implements it keyed on `soju.im/FILEHOST`, Basic from its
  stored PLAIN creds.
- #602 `draft/authtoken`: `TOKEN SERVICELIST` (batch `draft/authtoken *`, lines
  `TOKEN SERVICE <key> <url> :<desc>`, else `NOTE TOKEN NO_SERVICES`), `TOKEN GENERATE
  <service> [<scope>]` -> `TOKEN GENERATE <service> :<token>` (batched with `*` when long),
  `TOKEN VALIDATE [<service>] :<token>` usable PRE-REGISTRATION -> batch of `TOKEN CLAIM
  <key> :<value>` (account, member_of, name, operator_of, role, scope). Cap value token
  `client-batch` if client-initiated `draft/authtoken` batches are accepted. Service keys
  vendor-prefixed unless spec-defined (`FILEHOST` is spec-defined). FAILs: ACCOUNT_REQUIRED,
  INTERNAL_ERROR, INVALID_SCOPE, INVALID_TOKEN, NO_PERMISSIONS (scope / service), TIMEOUT,
  UNKNOWN_COMMAND, UNKNOWN_SERVICE; NOTE NO_SERVICES. Registration burst: SERVICELIST output
  after ISUPPORT when batch+authtoken negotiated; TOKEN NEW/DEL on changes.
  Recommendations: random single-use tokens, 10-15 min expiry, claims evaluated at VALIDATE
  time, validator authenticated (PASS / source range) else FAIL NO_PERMISSIONS <service>.
- #597 extoidc/OBJECTSTORAGE: heavier predecessor (CIBA + tus); SKIP unless a client needs it.
- #612 extended-isupport value concatenation: housekeeping for long ISUPPORT values.

## Ircd (ours)
1. `draft/authtoken` cap (+ `client-batch`), TOKEN command (3 subcommands), batch type,
   config block per service (key, url, description, validator credential: PASS and/or
   source CIDR), token table (random 32-byte, single-use, expiry 600 s, service, account,
   scope), claims at VALIDATE: account, name, member_of/operator_of (live channel state,
   channels only -- PM scope = `*`), scope. Registration-burst SERVICELIST; TOKEN NEW/DEL on
   rehash. All FAIL shapes per the table.
2. `draft/FILEHOST=<url>` in ISUPPORT when the FILEHOST service is configured; emit
   `soju.im/FILEHOST` as a documented compatibility alias (goguma).
3. Tests: tests/src/ircv3/authtoken.test.ts (servicelist burst + command, generate ->
   validate claims incl. member_of/operator_of, single-use, expiry via SET, wrong service ->
   INVALID_TOKEN, unauthenticated validator -> NO_PERMISSIONS, batched validate, FAIL table).
4. Docs: docs/features/authtoken.md, FEATURE_FLAGS_CONFIG.md.

## Site shim (ours to write, operator's to run)
FILEHOST on the outside (OPTIONS with Accept-Post, POST with Bearer -> 201 + Location),
`TOKEN VALIDATE` over an IRC connection on the inside (PASS = validator credential), then
`api.php?action=paste` with ONE service API key for text; images/video routed to the engine's
media component when integrated. GET/HEAD = the paste URL. Runs in the testnet compose against
the bed for development; delivered as a container or a PR to boxlabss/PASTE.

## Clients
- Seance: implement TOKEN GENERATE FILEHOST + Bearer upload (we control it; PR).
- goguma: Basic/Bearer only today; needs authtoken upstream (issue/patch) -- the shim does NOT
  accept Basic (that is the password transit we are avoiding).
- HexDroid: Sean's call.

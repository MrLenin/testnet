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

## Status
- 2026-09-10: ircd half SHIPPED on the fork (`7fd9ef8` authtoken + `891f2a1` batch
  UNKNOWN_TYPE), bed 6/6 (`tests/src/ircv3/authtoken.test.ts`), valgrind clean.
  Docs: `docs/features/authtoken.md`, FEATURE_FLAGS_CONFIG.md. Deviations from the
  plan below: no `client-batch` (tokens are one line), tokens replicate via P10
  `TK G/U` (validator may hit any server), validator PASS survives registration
  (per-connection service bitmask), +s channels hidden from claims unless scoped.
- 2026-09-10 (later): user asked whether the paste server could "speak normal web"
  instead of a shim holding an IRC connection -> JWT services SHIPPED `b8c054e`
  (spec's self-validating variant; `key` in the block; ES256; STATS authtoken shows
  the PEM; TOKEN VALIDATE still accepts the JWT), bed 7/7. The shim is no longer
  needed if boxlabss/PASTE gains a FILEHOST endpoint that verifies the JWT
  (contract in docs/features/authtoken.md). A paste.boxlabs.uk API key was
  provided (kept in .env.local, PASTE_API_KEY, never committed) -- useful for
  a fallback shim that posts to api.php, or for probing the API.
- NEXT: PASTE-side FILEHOST endpoint (PR to boxlabss/PASTE), then Seance.

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
`api.php?action=paste` with ONE service API key for text; images/video to the site's
`/img/` uploader (observed 2026-09-10: multipart POST to `/img/` itself with `images[]` +
`strip_exif=1`, JSON reply `{results:[{success,name,filePath,size,...}]}`, accepts
`image/*,video/*`, no visible auth on the page, not yet in the public boxlabss/PASTE tree) --
the shim converts the raw FILEHOST body into that multipart form and returns `filePath` as
Location. GET/HEAD = the paste / file URL. Runs in the testnet compose against
the bed for development; delivered as a container or a PR to boxlabss/PASTE.

## Clients
- Seance: implement TOKEN GENERATE FILEHOST + Bearer upload (we control it; PR).
- goguma: Basic/Bearer only today; needs authtoken upstream (issue/patch) -- the shim does NOT
  accept Basic (that is the password transit we are avoiding).
- HexDroid: Sean's call.

## PASTE-side scope (2026-09-10, after JWT services shipped)

Facts from the boxlabss/PASTE tree (`2e08296`): PHP >= 8.1, PDO + MySQL/MariaDB only,
openssl ext required, no composer (no php-jwt: verify ES256 with `openssl_verify`
directly, r||s -> DER is ~15 lines), pastes live in the DB (text only; slug or id
URLs; raw at `/raw/<slug>` via nginx rewrite), `includes/functions.php` has
`generateUniquePasteSlug`, `is_banned(ip)`; the live `/img/` uploader (images/video,
multipart, strip_exif) is NOT in the public tree.

### Deliverable A — PR to boxlabss/PASTE: `filehost.php` (self-contained module)

Endpoint `https://paste.boxlabs.uk/filehost` (nginx: `location = /filehost` ->
filehost.php; `location /filehost/` -> static files dir, or filehost.php?f= for HEAD/GET
with the stored Content-Type). Files:
1. `filehost.php` — OPTIONS / POST / GET / HEAD.
   - OPTIONS: 204, `Allow: OPTIONS, POST`, `Accept-Post: <FILEHOST_ACCEPT>`, CORS
     (`Access-Control-Allow-Origin: *`, `-Methods: POST, OPTIONS`, `-Headers:
     Authorization, Content-Type, Content-Disposition`, `Access-Control-Expose-Headers:
     Location`, `-Max-Age`). Browser clients (Seance) need every one of these.
   - POST: `Authorization: Bearer <jwt>` only (Basic -> 401 `WWW-Authenticate: Bearer
     realm="filehost"`; that is the password transit we refuse). Verify: alg ES256,
     signature with FILEHOST_PUBKEY (PEM from `STATS authtoken`), `iss` ==
     FILEHOST_ISSUER, `aud` == FILEHOST_URL byte for byte, `exp` > now-60, `iat` <=
     now+60, `jti` =~ /^[0-9a-f]{48}$/ and unseen (INSERT into `filehost_jti`; duplicate
     key = replay -> 401). Then `is_banned($ip)` -> 403; Content-Length > FILEHOST_MAX_BYTES
     -> 413; MIME (Content-Type, cross-checked with finfo on the body) not in
     FILEHOST_ACCEPT -> 415; per-account hourly cap from `filehost_files` -> 429.
   - Storage: `text/*` -> a paste row (member = FILEHOST_MEMBER service user, title =
     Content-Disposition filename or "IRC upload", syntax from MIME/extension via the
     existing shebang/extension helpers, visibility unlisted, expiry FILEHOST_EXPIRY);
     Location = the raw URL. Everything else -> file `FILEHOST_DIR/<slug>.<ext>` (ext from
     a MIME->ext table, never from the client), mode 0640, `filehost_files` row;
     Location = `<baseurl>filehost/<slug>.<ext>`. 201 + `Location` (absolute) +
     JSON body `{url, size, type, expires}` for humans.
   - GET/HEAD `/filehost/<slug>.<ext>`: `Content-Type` from the row, `Content-Length`,
     `Content-Disposition: inline; filename=`, `X-Content-Type-Options: nosniff`,
     `Cache-Control: public, max-age=…`; text raw is the existing paste raw path.
2. `includes/filehost_jwt.php` — `filehost_verify_jwt(string $jwt, string $pem, string
   $iss, string $aud, int $now): array|string` (claims or error code). Constant-time
   nothing needed (public-key verify), but reject `alg` != ES256 before anything else.
3. `includes/filehost_store.php` — the two storage paths + MIME table + jti sweep
   (`DELETE FROM filehost_jti WHERE exp < ?` on every POST, cheap).
4. `upgrade/2.1-to-2.2-filehost.sql` — `filehost_jti(jti CHAR(48) PK, exp INT, account
   VARCHAR(64), created DATETIME)`, `filehost_files(id, slug VARCHAR(16) UNIQUE, account,
   network, mime VARCHAR(127), size INT, ext VARCHAR(8), paste_id INT NULL, ip, created,
   expires DATETIME NULL)`; add to `docs/paste.mysqlschema.sql`; install step optional.
5. `docs/config.example.php`: `FILEHOST_ENABLED`, `FILEHOST_URL`, `FILEHOST_PUBKEY`,
   `FILEHOST_ISSUER`, `FILEHOST_DIR`, `FILEHOST_MAX_BYTES` (10 MiB), `FILEHOST_ACCEPT`
   (`image/*, video/*, text/*`), `FILEHOST_MEMBER`, `FILEHOST_EXPIRY` (paste expiry
   letter), `FILEHOST_PER_HOUR` (20). Admin-panel toggle deferred (constants first).
6. `docs/filehost.md` — operator guide: get the PEM from `STATS authtoken`, set
   `Authtoken "FILEHOST" { url = FILEHOST_URL; key = …; }` on the ircd, nginx snippet,
   retention/cron (`filehost.php?cron=1` or a CLI script to unlink expired files).
7. `docs/nginx.example.conf` additions.

Open for the maintainer: (a) EXIF stripping — their `/img/` does it; either expose
that function for `filehost_store.php` to call or accept a GD re-encode for JPEG/PNG
(lossy for JPEG); v1 ships WITHOUT it and says so in the response header
`X-Filehost-Exif: kept`. (b) Whether binary uploads should go through `/img/`'s
store instead of a new dir. (c) Abuse: takedown = delete the row + file; the
`account` + `network` columns identify the uploader for the ircd operators.

Deviations from #562 to state in the PR: Bearer carries an authtoken JWT, not an
OAUTHBEARER token (authtoken postdates FILEHOST); Basic is refused on purpose.

Estimate: ~450 lines PHP + SQL + docs; one working day; no dependencies.

### Deliverable B — testnet: run PASTE in the bed and gate end to end

`docker compose --profile paste`: `paste` (php:8.3-apache or nginx+fpm from the
boxlabss/PASTE tree, bind-mounted, `mod_rewrite`) + `paste-db` (mariadb, schema +
upgrade SQL + a seeded service user and the FILEHOST constants; FILEHOST_PUBKEY
generated from the bed's Authtoken key at container start by a tiny script so the
test key stays in one place). Vitest `tests/src/ircv3/filehost-e2e.test.ts`: TOKEN
GENERATE FILEHOST on the bed -> OPTIONS (Accept-Post, CORS) -> POST text and a PNG
with Bearer -> 201 + Location -> GET/HEAD match -> replay -> 401 -> Basic -> 401 ->
tampered/expired JWT -> 401 -> 413/415 shapes. Estimate: half a day. Also a good
fixture for reviewing the PR before sending it.

### Deliverable C — Seance

`TOKEN GENERATE FILEHOST <current buffer>` on attach/drop/paste of a file -> `POST
<draft/FILEHOST or soju.im/FILEHOST>` with `Authorization: Bearer` (fetch; CORS from A)
-> insert Location into the composer; progress + error toast; refuse when the
ISUPPORT URL is `http:` on a TLS connection (spec). Half a day; PR to evilnet/seance.

### Not in scope now
goguma (Basic only; needs authtoken upstream), resumable uploads, per-channel quotas,
X3 ACL-derived roles.

### Order
A (PHP) with B alongside so A is tested before it is sent; then C.

### Status 2026-09-10 evening
- A DONE on MrLenin/PASTE branch `filehost` (`3b5e12a`): filehost.php, jwt + store
  includes, SQL, .htaccess/nginx rules, config example, docs/filehost.md. PR to
  boxlabss/PASTE not yet opened (user's call on timing/wording).
- B DONE: `paste` submodule + docker/paste (Dockerfile, entrypoint deriving the PEM
  from data/ircd.conf via perl+openssl, gen-config.php, seed.sql) + compose profile
  `paste` (172.29.0.30/.31, port 8089) + tests/src/ircv3/filehost-e2e.test.ts 3/3.
  TRAP: `sed -i` on data/ircd.conf breaks the bind mount (new inode) -- the running
  ircd kept the old url until the file was rewritten in place (`docker exec -u root
  sh -c 'cat > local.conf'`) and rehashed; leaf oper block has a host mask so REHASH
  on 6668 from the host fails (restart the leaf instead).
- Behaviour note: the jti is recorded before size/type checks, so a 413/415/429
  spends the token (strict single use; clients mint again).
- C DONE: Seance PR https://github.com/evilnet/seance/pull/50 (branch
  MrLenin/seance feat/filehost-authtoken `1df882a`): irc/authtoken.ts, handlers/token.ts,
  FAIL TOKEN routing, serverOptions.FILEHOST, uploadFilehost + FilehostSource in
  upload.ts, paperclip gate; 16 mocha cases, build/lint/tsc clean. Browser-level run
  pending an https host (client refuses http over wss, per spec).
- A PR opened as DRAFT: https://github.com/boxlabss/PASTE/pull/20 (questions on EXIF,
  /img/ store, placement). User to un-draft when the wording suits.

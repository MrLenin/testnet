# Tier C F1-b — SVSINFO + MARK (version / sslclifp / geoip) over the mesh

> Design 2026-06-28. Slice scope approved by user: **SVSINFO + MARK WHOIS-visible subset**; ACCOUNT
> reclassified to Tier B (services-auth, do with CI). Continues `crdt-mesh-tier-c-scope.md` §F1 on the
> proven setter-hook template (SWHOIS/SVSIDENT `f3fb20c`, SETNAME `5a2b073`, AWAY `d97c6e5`).

## Goal
A user materialized on an overlay-only CRDT node (today leaf4/leaf5; every node post-MR-6) carries the
correct **realname (SVSINFO)**, **client version**, **SSL client fingerprint**, and **GeoIP
country/continent** — these are written RAW in the S2S handlers with no crdt_shadow hook, so under
tree-retirement they island. Fix = the standard 6-touch setter-hook per field.

## The proven template (per scalar field)
1. `include/crdt_state.h` — `#define CRDT_*LEN` + a field on `struct CrdtUserRecord`.
2. `crdt_shadow_user_add` — `strncpy(rec.X, cli_X(cptr), sizeof rec.X - 1)`.
3. `mat_user_cb` (mat-verify) — `MCK(strcmp(rec->X, cli_X(live)), "X")`.
4. `crdt_materialize_one_user` — copy the field onto the freshly materialized Client.
5. `crdt_reconcile_user_update` — drift clause: drive the REAL handler with `sptr=&me` + the
   `skip_crdt` one-shot (legacy-only re-emit; the inner `crdt_shadow_user_add` self-skips via
   `from_crdt_peer`); bump the `attr` counter.
6. Producer hook — `#include "crdt_shadow.h"` + `crdt_shadow_user_add(acptr)` after the raw write.

## Per token

### SVSINFO — realname (NO new field)
`ms_svsinfo` (m_svsinfo.c) writes `acptr->cli_info` — the **same field SETNAME already converges**
(`realname` in the record; reconcile clause `setnamed` already drives `ms_setname`). So ONLY touch 6:
`#include "crdt_shadow.h"` + `crdt_shadow_user_add(acptr)` after the `ircd_strncpy(acptr->cli_info,…)`.
Receive/gateway is free — the existing realname reconcile path carries it.

### MARK — three WHOIS-visible sub-types (new fields)
`ms_mark` (m_mark.c) dispatches by `parv[2]` sub-type; each writes a different `cli_*`:
- **MARK_CVERSION** → `cli_version` (VERSIONLEN 250). Doc field `version[CRDT_VERSIONLEN=128]` (capped;
  real CTCP versions are short, >127 truncates — cosmetic, like swhois).
- **MARK_SSLCLIFP** → `cli_sslclifp` (BUFSIZE 512). Doc field `sslclifp[CRDT_SSLFPLEN=96]` (SHA-256
  CertFP = "SHA256:" + 64 hex ≈ 71; capped).
- **MARK_GEOIP** → `cli_countrycode`/`cli_continentcode` (2-char codes) via `geoip_apply_mark`, which
  ALSO derives countryname/continentname + `SetGeoIP`. Doc carries only the two **codes**
  (`countrycode[3]`, `continentcode[3]`); materialize/reconcile call
  `geoip_apply_mark(nc, cc, cont, NULL)` to rebuild names + flag locally. GeoIP comes from iauth/services
  (s_auth.c:2870) not pure IP-derivation, so a far node genuinely needs the codes.

**Reconcile-driving gotcha (the one real trap):** `ms_mark` resolves its target via `FindUser(parv[1])`
= **by NICK**, NOT `findNUser` (numeric) like ms_svsident/ms_swhois. So the MARK drift clauses pass
`cli_name(live)` as `parv[1]`, never the `numbuf` numeric. Shape: `pv[0]=cli_name(&me)`,
`pv[1]=cli_name(live)`, `pv[2]=MARK_*`, `pv[3..]=values`; `ms_mark(cli_from(live), &me, parc, pv)` +
`sendcmdto_set_skip_crdt_servers()` first. (`ms_mark` requires `IsServer(sptr)` → `&me` satisfies it.)

### Carve-OUT (NOT converged — by design)
`MARK_WEBIRC` (spoofed-host source) and `MARK_SSLCLIEXP` (cert-expiry ts) are home-server-only
connection-handshake attributes — same reasoning as the 5-5e caps carve-out (a synthetic remote
materialized user has no socket; these matter only where the real connection lives). Documented here so
the omission is explicit, not silent (`feedback_no_silent_defer`). `MARK_KILL` is not user-state.

## Files touched
`include/crdt_state.h` (3 lens + 4 fields) · `ircd/crdt_shadow.c` (user_add pack ×4, mat_user_cb MCK
×4, materialize copy ×4, reconcile drift clauses ×3 [SVSINFO free], `#include ircd_geoip.h` if absent) ·
`ircd/m_svsinfo.c` (include + hook) · `ircd/m_mark.c` (include + hook at the 3 sub-type sites).

## Record-size note
+~230 bytes/user (128 version + 96 sslclifp + 3 + 3). Acceptable for the testbed; flag if it pressures
snapshot/CR-F chunking at scale.

## Validation (live, 5-node bed — no cmocka: integration-layer, per the skill rule)
Mirror the SWHOIS validation. On a leaf user (e.g. alice@nef7/leaf5):
1. **CVERSION** — services/oper sets a client version mark → far overlay-only leaf (nef4/leaf2) shows it
   (oper WHOIS / `cli_version`) within a reconcile cycle; `attr` counter logs ≥1.
2. **SSLCLIFP** — set a CertFP mark → far leaf oper-WHOIS shows the fingerprint.
3. **GEOIP** — apply a geoip mark → far leaf shows the country (WHOIS 344/338 + `cli_countrycode`) AND
   the derived countryname (proves local `geoip_apply_mark` rebuild).
4. **SVSINFO** — services SVSINFO on a leaf user → realname converges far (reuses the setname path).
5. Negatives: `attr` stays 0 on normal users (no spurious churn); 0 crash-markers nef3-7; existing
   realname/swhois re-tests still converge with the larger record.

## VALIDATION RESULT (2026-06-29, 5-node CRDT bed)
- cmocka gate PASS; binaries fresh on nef3-7 (`ircd.202606290235`, no cache trap).
- **Regression PASS:** SWHOIS still converges end-to-end with the enlarged record — alice@nef7(leaf5)
  opers up → bob@nef4(leaf2, far overlay-only) WHOIS shows the oper swhois in ~4s.
- **Zero mat-check gaps** on version/sslclifp/countrycode/continentcode across all 5 nodes.
- **No spurious churn:** `attr` increments only for the real swhois change; the new MARK reconcile
  clauses stayed dormant on unmarked users (the no-spurious-mark goal).
- 0 asserts, all 5 healthy. (One benign transient `umode` gap during oper-up convergence — existing
  field, self-resolves.)
- **DEFERRED live exercise (per `feedback_no_silent_defer`, matches the SWHOIS/SVSIDENT precedent):** a
  real non-empty MARK value (version/sslclifp/geoip) converging was NOT live-driven — MARK is
  services/iauth-sourced and x3 isn't on the CRDT-only bed; private docker IPs don't geolocate. The
  pack→materialize→reconcile-drive mechanism is byte-identical to the proven swhois/realname path; the
  one F1-b-specific risk (ms_mark resolves by NICK not numeric) is handled in the reconcile clauses.
  To exercise fully: full bed (.2+x3+keycloak) + OperServ MARK, or an SSL client cert for sslclifp.

## Constraints (standing)
Submodule push `origin crdt-mesh`; testnet pointer stages ONLY `nefarious-crdt`; commit trailer
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; `data/ircd*.conf` uncommitted;
no throwaway tooling committed; use `scripts/dc.sh`; verify the `ircd.YYYYMMDDHHMM` symlink advances
(build-cache freshness oracle). Commit per phase OK on crdt-mesh (`feedback_crdt_commit_each_phase`).

# CRDT-mesh clock-injection live harness

Deterministic timing-race validation for the `nefarious-crdt` mesh: per-node fake
wall-clock skew (static, via env) and runtime clock steps (via an oper command)
drive scenarios that ad-hoc pokes on a synced-clock bed cannot reproduce.

Scope + design: `.claude/para/projects/crdt-mesh-clock-injection-harness-scope.md`.
Run-1 results + findings: `.claude/para/projects/crdt-mesh-clocktest-findings.md`.

## Prerequisites

- **Debug build.** The clock hook (`ircd_fake_clock_offset`, crdt-mesh `3eb3228`)
  is `#ifdef DEBUGMODE` only — compiled out of release builds. The testbed's
  `--enable-debug` images have it.
- **The clocktest compose overlay** (per-node `IRCD_FAKE_CLOCK_OFFSET`, valgrind off):

  ```bash
  COMPOSE_FILE="docker-compose.yml:docker-compose.libkc-dev.yml:docker-compose.clocktest.yml" \
    scripts/dc.sh --profile multi up -d --no-deps nefarious3 nefarious4 nefarious5 nefarious6 nefarious7
  ```

  (Set `COMPOSE_FILE` yourself and skip `-l` — `dc.sh -l` hardwires its own
  two-file stack. Bring nodes up hub-first: 3, 4, 5, 6, 7.)
- **Oper privileges.** The scenarios oper up as `oper`/`shmoo` and need
  `gline = yes; jupe = yes; rehash = yes;` on that Operator block in
  `data/ircd{3..7}.conf`. Note the configs are per-file bind mounts (nef3 rw,
  nef4-7 ro): edit the host file in place (no rename) and `kill -HUP 1` in the
  container.

## Running

Each scenario is standalone; run from this directory:

```bash
python3 spike1.py     # clockstep sanity: TIME moves ±, mesh unaffected
python3 s1_m12.py     # M12 same-second gline lastmod collision
python3 s2_m15.py     # m15 skew delete-on-leave (+30 nef4 vs nef5)
python3 s5_m8.py      # M8 metadata CLEAR no-resurrect (needs testadmin/AuthServ)
python3 s6_m13.py     # M13 stepped expiry (gline+jupe); restarts nef7 in cleanup
```

Exit code 0 = PASS. `s2b_diag.py` / `s5b_diag.py` are dense-observation probes
used to root-cause run-1 anomalies; keep for regression forensics.

Not CI-wired by design (multi-node mesh, partitions, ~2-8 min each) — a
manual / nightly target.

## Conventions the scenarios encode (learned the hard way)

- **Convergence oracle = `mdigest`** from `/CRDT status` (GC-invariant). The raw
  doc digest legitimately flaps during per-node GC and expiry-tombstone waves.
- Convergence is asserted as *reached within a bounded window* (poll), never as
  an instant snapshot.
- **Global glines need the explicit `*` target** (`GLINE +mask * <dur> :reason`);
  the target-less form is a LOCAL gline (different priv, never touches the doc).
- `STATS G` lastmod is rewritten by the doc-reconcile drive; mint-time evidence
  is the "adding global GLINE ... expiring at E" notice (E − duration).
- Same-second collisions: fire mid-second (frac ~0.35), fresh mask per attempt.
- Scenario glines use short (90 s) expires so residue tombstones don't mutate
  the doc during later scenarios.
- A big forward `clockstep` ping-drops that node's established local clients
  (NTP-step analogue — expected). Undo big steps by **restarting the node**,
  never by stepping back (re-armed absolute-time timers would go silent for the
  step's duration).

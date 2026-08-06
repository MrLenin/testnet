# x3-migrate

Offline converter + census for the X3-into-Nefarious merge (Phase 0 slice).
Plan of record: `.claude/para/projects/x3-merge-sequencing.md` §4; design spec:
`docs/superpowers/specs/2026-08-06-x3-migrate-census-design.md`.

Read-only over COPIES of `x3.db` / LDIF exports — never point it at live files.

## Census

    cd tools/x3-migrate
    npm install
    npm test                                  # full gate, no bed needed
    # bed baseline (copy first):
    ../../scripts/dc.sh exec x3 cat /x3/data/x3.db > /tmp/x3db.copy
    npx tsx src/cli.ts census --db /tmp/x3db.copy [--ldif export.ldif] [--json report.json]

Exit codes: 0 = clean (GO), 2 = anomalies (NO-GO), 1 = parse/usage failure.
Without `--ldif` the credential split is local-hash-only vs absent (both-D1-branch
mode); the four-way split needs a directory export (`slapcat` from the openldap
container).

`convert` / `residual` / `bans` are reserved for later merge phases.

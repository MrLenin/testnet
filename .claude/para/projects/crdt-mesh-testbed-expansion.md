# CRDT-mesh testbed expansion — 3 → 5 CRDT nodes

Why: the current 3-node star+overlay (nef3 hub; nef4/nef5 leaves; nef4↔nef5 overlay) is only 1-deep
with a single redundant edge. It can't exercise **genuine multi-hop depth** (R2 recursive keep-alive at
depth ≥2) or **real multi-path routing** (R4) — the headline roadmap items. Expand to 5 CRDT nodes with
a 2-deep tree + a redundant-edge mesh. (4 is the minimum useful step; 5 gives symmetric branches.)

## Current
- Numerics: nef3=3, nef4=4, nef5=6 (env `IRCD_GENERAL_NUMERIC`; nef5's "AG" = base64(6)). nefarious2=2.
- IPs: nef3 172.29.0.6, nef4 .7, nef5 .9. Client ports: nef3 6669, nef4 6670, nef5 6672 (+TLS 669x/670x/670x).
- P10: nef1(.2, legacy hub) → nef3 → {nef4, nef5}. Overlay nef4↔nef5.
- Each node = a compose service pair (`nefariousN-init` + `nefariousN`) in docker-compose.yml, profile
  `multi`, build context `./nefarious-crdt`, mounts `./data/ircdN.conf`, fixed IP, NAME/NUMERIC env.

## Target topology (5 CRDT nodes)
P10 spanning tree (stays a tree — legacy plane):
```
nef1 (legacy hub, .2)
  └─ nef3 (hub2,  .6, num 3)
       ├─ nef4 (leaf2, .7, num 4) ── nef6 (leaf4, .10, num 7)   branch A, depth 2
       └─ nef5 (leaf3, .9, num 6) ── nef7 (leaf5, .11, num 8)   branch B, depth 2
```
CR-only overlays (FLAG_CRDT_OVERLAY, the redundant mesh edges):
- nef4↔nef5  (existing — cross branches at depth 1)
- nef6↔nef7  (cross branches at depth 2)
- nef6↔nef3  and  nef7↔nef3  (a depth-2 node stays mesh-reachable when its depth-1 parent partitions)

This yields: genuine depth-2; two symmetric branches; ≥2 disjoint CR paths between most pairs (tree +
overlay) for R4; and the partition cases R2 needs (cut nef3—nef4 → nef4+nef6 subtree departs on nef3;
nef6 stays mesh-reachable via nef6↔nef3 / nef6↔nef7→nef5→nef3).

## Steps
1. **docker-compose.yml** — add `nefarious6`/`nefarious6-init` and `nefarious7`/`nefarious7-init` by
   cloning the nef5 pair: IPs .10/.11, aliases leaf4/leaf5.fractalrealities.net, ports 6673/6703 +
   6674/6704, mounts `./data/ircd6.conf`/`ircd7.conf` + per-node volumes (history/metadata/webpush/ssl
   _data6/_7), env NAME=leaf4/leaf5, NUMERIC=7/8, profile `multi`, depends_on its P10 parent
   (nef6→nef4 healthy, nef7→nef5 healthy) + its init. Declare the new named volumes.
2. **data/ircd6.conf / ircd7.conf** — clone ircd5.conf: Port 4496; connect-UP to the P10 parent
   (nef6→nef4 .7, nef7→nef5 .9, `hub; autoconnect`); the `CrdtMesh` class block; passive crdtmesh
   accept blocks + autoconnect crdtmesh blocks per the overlay set above. Mirror nef4/nef5/nef3 to add
   the matching passive sides (nef4 gets a passive P10 block for nef6; nef3 gets passive crdtmesh for
   nef6/nef7; etc.). **Configs stay UNCOMMITTED** (testnet-local, per the standing rule).
3. **Numerics**: nef6=7, nef7=8 (5 is free; avoid clashing 2/3/4/6). Verify base64: 7="AH", 8="AI".
4. Bring up: `scripts/dc.sh -l --profile multi up -d --build nefarious6 nefarious7` (the build reuses
   the nefarious-crdt image layers). Verify all 5 link + the overlays autoconnect (the overlay
   autoconnect is flaky — `restart` the initiator side if an overlay doesn't come up) + 5-way
   `shadow verify` digest convergence.
5. **Re-verify R2 at real depth**: cut nef3—nef4 → nef6 (depth-2) survives on nef3 via R2/anchor; cut
   that keeps nef6 mesh-reachable via its overlays. Update the test harness (`/tmp/crdt4c/`) for 5 nodes.
6. Update the `crdt-mesh` skill's topology note + memory.

## Risks / notes
- IP/numeric/port collisions — pick from free ranges (.10/.11; num 7/8; ports 6673/6674).
- Overlay autoconnect flakiness compounds with more edges — may need restart nudges; document.
- Build/disk: 2 more containers; the nefarious-crdt image is shared (layer-cached), so marginal.
- Each `up` wakes the whole topology cleanly (esp. pdns-recursor deps) — use `scripts/dc.sh`, batch edits.
- This is test INFRA, not fork code — no submodule commit; configs + compose stay testnet-local
  (compose IS committed in the testnet repo though — decide whether to commit the 5-node compose or
  keep it local; recommend committing compose + the configs as the durable 5-node testbed).

## Results (2026-06-11) — DONE, 5 nodes up + converged

Built nef6 then nef7. **5-way convergence achieved**: all of nef3/nef4/nef5/nef6/nef7 report
`3 channels, 7/7 users, 5 servers, 0 mismatch(es)` with an identical digest. Depth-2 R2 re-verified
on the genuine tree (see below). Final addressing differs from the original plan — gotchas:

### Addressing (CORRECTED — original .10/.11 were taken)
- **IPs**: nef6 = **172.29.0.14**, nef7 = **172.29.0.15**. (.10 = keycloak, .11/.12 also taken; .13 =
  openldap, .20 = pdns. First free block is .14+.) Update the topology diagram above accordingly.
- **Numerics**: nef6 = 7 ("AH"), nef7 = 8 ("AI"). **Ports**: nef6 6673/6703, nef7 6674/6704.
- Overlays as planned: nef4↔nef5 (existing), nef6↔nef3, nef7↔nef3, nef7↔nef6 (nef7 initiates both its).

### HUB config is REQUIRED for depth-2 (was missing from the original steps)
A depth-2 downlink needs TWO things or it is rejected by `check_loop_and_lh`:
1. The **intermediate hub** (nef4 for branch A, nef5 for branch B) must set `"HUB"="TRUE"` — a non-hub
   server with an existing uplink rejects any further server link with **I_AM_NOT_HUB**
   (m_server.c:141, the `ghost`/direct-registration path).
2. The hub2 **`Connect{}` block for that intermediate** (nef3's leaf2/leaf3 blocks) needs bare `hub;`
   → sets `hub_limit="*"`, `maximum=65535` (parser ircd.c:703) → the relayed depth-2 server passes the
   `hop > maximum` / `NOT_ALLOWED_TO_HUB` gate. The primary hub's hub2 block already had `hub;` so hop-3
   (leaf4/leaf5 seen from nefarious .2) is fine. `match("*",host)==0` so the hub_limit branch is skipped.

### Bring-up sequencing (the autoconnect races — IMPORTANT)
- The healthcheck is `pgrep ircd`, which goes green **before** the 4496 listener is up (valgrind boot is
  ~60-90s). A node that autoconnects before its uplink target is listening gets **"Connection refused"**
  → SQUIT → backoff. **Always**: restart the *targets* first, poll until `.6/.9/.14` accept on 4496
  (a netshoot sidecar on `testnet_irc_net` + `nc -zv`), *then* restart/start the initiator.
- A **stuck P10 uplink** (e.g. nef6→nef4, nef7→nef5 after a chaotic multi-restart) can be forced
  immediately with oper `CONNECT <uplink-name> 4496` from a client on the initiator (port 6673/6674,
  `OPER oper shmoo`). This is the reliable nudge; it does NOT disturb other links.
- **Overlay retry is on the 10-min cycle.** `try_connections` reschedules at
  `CurrentTime + FEAT_CONNECTFREQUENCY` (default **600s**, ircd.c:519). Overlays (CONF_CRDTMESH) only
  re-autoconnect on that periodic tick; a fresh boot runs it at +1s (ircd.c:1215) so new nodes connect
  fast, but an overlay that drops **mid-session waits up to 10 min** to recover. You **cannot** force an
  overlay with `CONNECT` (that builds a P10 link, not an overlay) — either wait out the cycle or restart
  the initiator (which re-runs try_connections at boot). The CrdtMesh class `connectfreq=30s` only sets
  the per-conf `hold` *after* a tick; it does not shorten the 10-min scheduling interval.
- **Don't restart 3+ CRDT nodes simultaneously** — it leaves the P10 tree unformed (every node islands
  with an empty doc) and several overlays stuck till the 10-min cycle. Restart the minimum set, targets
  before initiators.

### R2 at genuine depth-2 (re-verified on the real tree, not the synthetic one)
`/tmp/crdt4c/r2depth.sh`: a user on the depth-2 node nef6, then cut the nef3↔nef4 P10 edge → the whole
branch-A subtree (nef4 AE + nef6 AH) departs nef3's tree; nef3 emits `tree-split but mesh-reachable` +
`synthetic anchor for server AH`; the nef6 user **survives immediately** on nef3 via the nef6↔nef3
overlay (WHOIS 311, not after the 30s timer); PRIVMSG delivers via mesh; heal reconverges, 0 crashes.
The transient post-test digest split (nef6 4fb0… vs others f28b…) was deep-quit/#r2d-teardown
propagation lag, resolved in ~20s. The `N channels` count is *locally-materialized* (nef4/nef6 show 0
when they have no local members — the doc still carries all channels; identical digest + 0 mismatch).

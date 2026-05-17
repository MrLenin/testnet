# draft/persistence unification

**Status:** Plan, design agreed 2026-05-17

**Upstream context:**
- [ircv3/ircv3-specifications#503](https://github.com/ircv3/ircv3-specifications/pull/503) — base PERSISTENCE STATUS/GET/SET protocol
- [MrLenin gist 814a674c](https://gist.github.com/MrLenin/814a674c8fd4f34f40a21a91b15d0640) — Afternet extension adding LIST/ATTACH/DETACH + persistence batch
- This plan: implements both, plus a REPLAY trio and vendor-scoped bouncer-replay batch

**Internal docs:** [bouncer-persistence-redesign.md](bouncer-persistence-redesign.md) (internal redesign — complete; this plan is the wire-protocol surface that exposes it to clients)

## Goal

Replace the in-house `BOUNCER SET HOLD on/off`, `BOUNCER INFO`, `BOUNCER LISTCLIENTS` wire surface with spec-aligned `PERSISTENCE` commands while preserving the in-house surface for one release cycle for tooling compat.

Add the missing user-facing knob to disable auto-replay of missed messages (3-state matrix gap: `draft/chathistory=no, want-replay=no, currently forced-replay`).

Wrap the bouncer-attach-time wire surface in batches so clients can suppress server-initiated replay distinctly from live activity.

## Phasing

Each phase is a separate commit (or small commit stack). Tests land alongside.

### Phase 1 — Base protocol (PR #503 compat) + server-managed metadata carve-out

- New `m_persistence.c` with handlers for `STATUS`, `GET`, `SET`
- CAP advertise: `draft/persistence`
- Wire `PERSISTENCE SET ON/OFF/DEFAULT` to existing `bouncer/hold` metadata via the existing m_bouncer.c path (so the S2S broadcast machinery from `abac5f4` is reused).  `DEFAULT` deletes the key (delete-form on the wire is `METADATA <target> <key>` with no value); the `metadata_set_client(..., NULL, ...)` path already handles this.
- Unsolicited `PERSISTENCE STATUS` sent after the final 005 numeric and before MOTD-end when the client negotiated `draft/persistence` AND is authenticated
- Error families: `ACCOUNT_REQUIRED`, `INVALID_PARAMETERS`, `INTERNAL_ERROR`

**Server-managed metadata carve-out** (lands with Phase 1 — required for `PERSISTENCE` to be a coherent API rather than syntactic sugar over `METADATA`):

- Reserved prefix: `bouncer/` (and future `system/`, `s2s/` as needed).  Keys under these prefixes are server-managed — only set via privileged paths like `PERSISTENCE SET`.
- `m_metadata.c::metadata_cmd_set` rejects client SETs to server-managed prefixes with `FAIL METADATA KEY_READONLY :Server-managed metadata`.
- `metadata_count_*()` excludes server-managed keys from the count — they don't eat into the user's max-keys budget.
- Internal helper `metadata_set_client_internal(...)` bypasses the SET check; used by `PERSISTENCE SET`, the auth/account flow, and any other server-initiated metadata write.
- Server-managed keys remain readable via `METADATA GET` so clients can inspect.

Tests: STATUS unsolicited, GET, SET roundtrip, error handling, server-managed write rejection, server-managed exempt from limit count.

### Phase 2 — Persistence batch + bouncer-replay batch

- Wrap `bounce_send_channel_state()`'s JOIN/TOPIC/NAMES burst in `BATCH +ref draft/persistence ... BATCH -ref` when the client has both `draft/persistence` and `batch` negotiated
- Wrap the existing `replay_start_bouncer()` output in an OUTER `BATCH +ref evilnet.github.io/bouncer-replay ... BATCH -ref`.  Per-target `chathistory` batches inside `replay_open_batch()` get the outer ref as parent (IRCv3 batch nesting).
- Suppress the outer bouncer-replay batch when there is nothing to replay (mirrors the existing `replay_send_summary` empty-batch suppression).
- Update [bouncer-pm-replay.test.ts](../../tests/src/ircv3/bouncer-pm-replay.test.ts) + add tests for the new batch wrapping.

**Spec-text addendum for the gist** (drop in under "Channel Restoration Batch"):

> After the `draft/persistence` batch closes and before live activity, servers MAY emit an `evilnet.github.io/bouncer-replay` batch containing missed-message replay.  Clients honoring `REPLAY OFF` will not receive this batch.  Within the batch, individual `chathistory` batches per conversation target follow normal IRCv3 chathistory semantics.  The outer batch boundary signals the complete replay block — useful for unread-marker rollup, do-not-disturb rules, and notification suppression.

### Phase 3 — REPLAY trio + hs_enforced flag + DETACH

REPLAY trio (mirrors HOLD):

- `PERSISTENCE REPLAY GET`
- `PERSISTENCE REPLAY SET <ON|OFF|DEFAULT>`
- `PERSISTENCE REPLAY STATUS <client-setting> <effective-setting>`

CAP value token: `draft/persistence=replay-control` (and `list,attach` from Phase 4).

Storage: new metadata key `bouncer/auto-replay` (PRIVATE, S2S broadcast same as `bouncer/hold` via [the `abac5f4` path]).  Reader: new `persistence_replay_enabled_for(client)` helper.  Default ON when metadata absent; OFF only when explicitly set to `0`.

`s_user.c` auto-replay site changes from:
```c
if (!CapOwnHas(ghost, CAP_DRAFT_CHATHISTORY))
  replay_start_bouncer(...);
```
to:
```c
if (!CapOwnHas(ghost, CAP_DRAFT_CHATHISTORY)
    && persistence_replay_enabled_for(ghost))
  replay_start_bouncer(...);
```
Same change at the BX C session-move site.

**REPLAY scope clarification (spec-text):**

> `PERSISTENCE REPLAY <setting>` controls only missed-message replay (the `evilnet.github.io/bouncer-replay` batch).  It does NOT affect the `draft/persistence` channel-state batch (JOIN/TOPIC/NAMES are part of the client's current state on the server, not historical).

**hs_enforced flag (per the user's DETACH-edge-cases memory):**

- Add `hs_enforced` bit to `struct BouncerSession`
- Set when a connection on a `CRFLAG_BOUNCER` class attaches to (or creates) the session
- Clear when the session transitions to HELD (all connections gone) — lets a future non-enforced connection DETACH a stale-enforced session
- Persist alongside other session state (MDBX schema bump or version field)

**DETACH:**

- `PERSISTENCE DETACH [<session-id>]`
- Refuse with `FAIL PERSISTENCE CANNOT_DETACH` when `hs_enforced` is set
- Otherwise: disconnect all aliases, mark session for destruction, reply `PERSISTENCE STATUS OFF OFF`, caller proceeds as a normal non-persistent client
- If `<session-id>` is a different session owned by the same account: destroy that session without affecting the caller

### Phase 4 — Configuration profiles + network-membership reconciler

**Design:** [resources/session-as-profile-design.md](../resources/session-as-profile-design.md).  All nine open questions resolved 2026-05-17.

Replaces the prior "LIST sessions + ATTACH session" framing.  Sessions
under the new model don't denote separate identities; they denote
named configuration profiles over a single shared bouncer identity.
Each profile owns its own channel list, and the bouncer reconciles
network-level membership against the union of active profiles' lists
(HOLD-sticky when a profile has no current aliases attached).

Wire surface:

```
PERSISTENCE PROFILE LIST                       # enumerate
:srv PERSISTENCE PROFILE <name> [k=v ...]
:srv PERSISTENCE PROFILE ENDOFLIST

PERSISTENCE PROFILE CREATE <name> [FROM <parent>]
PERSISTENCE PROFILE DELETE <name>
PERSISTENCE PROFILE RENAME <old> <new>
PERSISTENCE PROFILE GET <name> <key>
PERSISTENCE PROFILE SET <name> <key> <value>
PERSISTENCE PROFILE SET <name> <key> DEFAULT   # clear override
PERSISTENCE PROFILE SET <name> channels +#x    # set ops
PERSISTENCE PROFILE SET <name> channels -#x

PERSISTENCE ATTACH <profile>                   # pre-CAP-END only
```

Implementation milestones (each lands as a separate commit cycle):

| M | Scope | Tests |
|---|---|---|
| **M1** | Profile metadata storage + CRUD subcommands (LIST/CREATE/DELETE/RENAME/GET/SET) + inheritance resolution + cycle detection.  No channels yet, no active-profile attachment. | profile CRUD roundtrip; inheritance walk; cycle refusal |
| **M2** | `PERSISTENCE ATTACH` pre-CAP-END; active-profile state on Connection; STATUS/SET resolution chain through active profile + parent chain + account-global + FEAT_*. | ATTACH selects profile; unsolicited STATUS reflects active profile's resolved hold |
| **M3** | Channel-list storage per profile + view-only filter at every channel send site (per-delivery profile-list check); no reconciler yet — channels are added/removed via explicit PROFILE SET only. | client on profile A doesn't see #x traffic when #x not in A's list |
| **M4** | Full reconciler: `/JOIN`/`/PART` edit active profile's list and emit network-level JOIN/PART deltas against the union; attach/detach triggers re-reconciliation; HOLD-sticky for inactive profiles. | same-profile aliases share JOIN/PART; cross-profile aliases don't; HOLD-on keeps channels sticky; HOLD-off drops on last-detach |
| **M5** | Inheritance for channel lists (set-merge semantics: parent's + own additions − own subtractions). | inherited channel list flattens correctly; explicit subtract overrides inherited add |

Legacy surface: `BOUNCER SET HOLD` and `BOUNCER INFO` continue to work
on the account-global key (Q2 — `PERSISTENCE SET` writes the same
key).  The `BOUNCER LISTCLIENTS` surface is unaffected (per-connection
info, not per-profile).

### Phase 5 — Legacy surface deprecation (later)

After Phase 1-4 land + clients have a release to adapt:

- `BOUNCER SET HOLD` → emit a deprecation NOTICE pointing at `PERSISTENCE SET`
- `BOUNCER INFO` → deprecation NOTICE pointing at `PERSISTENCE STATUS`
- `BOUNCER LISTCLIENTS` → deprecation NOTICE pointing at `PERSISTENCE LIST` (different shape; per-connection info vs. per-session) — could also keep this one as our extension since the spec's LIST is session-level not connection-level
- **Umode `+b` (`FLAG_BNC_HOLDPREF`)** → deprecation NOTICE.  The umode only tracks the *preference* (`bouncer/hold` truthy), not the *effective* state — which is the actually-useful signal `PERSISTENCE STATUS` provides.  In a future major version, drop the entry from `userModeList[]` (s_user.c:1034), drop the `bouncer/hold` row from `metadata_mode_sync[]` (metadata.c:1134), and retire `FLAG_BNC_HOLDPREF`.  Frees the `+b` letter for reuse.

Don't actually remove the old surface in this plan — that's a future cleanup.

## Open questions

1. **Vendor scope** — settled on `evilnet.github.io/bouncer-replay` (resolved 2026-05-17).  Reasoning: vendor-scope should follow the software (Nefarious2 / evilnet org), not the network operator (afternet.org).  `evilnet` doesn't own a custom domain, but its GH Pages host `evilnet.github.io` is DNS-resolvable and demonstrably controlled by the evilnet GH org — satisfies IRCv3's "domain you control" convention.  If evilnet acquires a project domain later, promote the namespace then.

2. **MONITOR/WATCH interaction** — the gist's "Open Questions §3" mentions pre-away interaction with MONITOR.  Not relevant to Phase 1-3; revisit when LIST/ATTACH lands in Phase 4 (a connection ATTACHing should not emit a MONITOR online event if the session was already ACTIVE under another connection — that's not a presence transition for the user).

3. **Spec PR** — Once Phase 1-2 ship and bake, propose the gist as a follow-up to PR #503 upstream.  The REPLAY trio + bouncer-replay-batch additions go into the same PR.  Vendor-scoped batch can be promoted to `draft/bouncer-replay` if upstream wants to standardize, or stay vendor-scoped indefinitely.

## Implementation order summary

| Phase | Submodule files | Test files | Wire surface added |
|---|---|---|---|
| 1 | `m_persistence.c` (new), `m_cap.c`, `s_user.c` | new `persistence-base.test.ts` | `PERSISTENCE STATUS/GET/SET`, CAP, unsolicited STATUS |
| 2 | `bouncer_session.c`, `replay.c` | update `bouncer-pm-replay.test.ts`, add `persistence-batch.test.ts` | `BATCH draft/persistence`, `BATCH evilnet.github.io/bouncer-replay` |
| 3 | `m_persistence.c`, `bouncer_session.c`, `s_user.c`, `metadata.c` | new `persistence-replay.test.ts`, `persistence-detach.test.ts` | `PERSISTENCE REPLAY GET/SET/STATUS`, `PERSISTENCE DETACH`, `hs_enforced` |
| 4 | `m_persistence.c`, `s_auth.c`, registration flow | new `persistence-list-attach.test.ts` | `PERSISTENCE LIST/SESSION/ENDOFLIST`, `PERSISTENCE ATTACH` |
| 5 | `m_bouncer.c` | (no new tests) | Deprecation notices on legacy commands |

## Migration notes

- All Phase 1-3 wire changes are additive — existing `BOUNCER`-command clients see no change.
- **Pool-cleanup hook retires after Phase 1.**  The `wipePoolAccountMetadata` machinery from `515419f` can be replaced with a simple `PERSISTENCE SET DEFAULT` (or the equivalent legacy `BOUNCER SET HOLD default` if we add that alias) from each test's `afterEach`.  Cleaner: no oper roundtrip, uses spec-aligned commands, fewer moving parts in the pool helper.  Keep the offline-targeted `wipePoolAccountMetadata` path for the cleanup-tests script's offline-account case.
- **Legacy `BOUNCER SET HOLD default` alias** (optional, in Phase 1): a 3-line addition that maps `BOUNCER SET HOLD default` → `metadata_set_client_internal(sptr, "bouncer/hold", NULL, ...)`.  Backward-compatible with the existing 2-state on/off; gives legacy-command clients the third state without waiting for the persistence migration.
- MDBX schema bump in Phase 3 for `hs_enforced` — add a version field check, default to 0 for legacy records.

## Out of scope

- Multi-session-per-account (the gist's LIST/ATTACH supports the wire format for it, but the in-house redesign defers multi-session-per-account architectural work — see [project_bouncer_multi_session_neutral](../../memory/project_bouncer_multi_session_neutral.md)).  Phase 4 LIST will return 0 or 1 sessions in practice.
- Cross-server PERSISTENCE LIST consistency (LIST returns whatever the local server sees; HELD sessions on remote servers are visible via the normal replication).
- Oper-scoped session kill (per [project_persistence_oper_detach](../../memory/project_persistence_oper_detach.md), implement as Nefarious extension separately).

# Per-alias cap discovery for BX M dispatch

## Goal

`emit_bxm_to_remote_member` (the sender-side BX M / BX E gate) currently
decides which token to use based on `IsMultiline(cli_from(alias))` —
the alias's directly-connected server's multiline-capability flag.
That's a proxy for the alias's actual `draft/multiline` cap negotiation
state, and it's wrong in the common cases where:

- The alias is on a multiline-capable server but its *client* never
  REQ'd `draft/multiline`.  Sender ships a BX M batch over S2S; the
  receiving server's `deliver_s2s_bxm_batch` falls through to
  `send_multiline_fallback` because the alias lacks the cap.  Wire
  bytes wasted on BATCH framing the receiver immediately discards.
- The alias is bouncer-aware but multiline-non-capable somewhere
  midway upstream (in our fork these ship together, but a future
  fork variant could split them).

Receiver delivery is **always correct** — `deliver_s2s_bxm_batch`
checks the local alias's cap state and falls back as needed.  This
plan is purely a wire-efficiency optimisation: pick BX M only when
the alias actually has the caps to render it.

## Wire format

Reuse `BX U` (identity update) with a new field name `caps`:

```
BX U <alias_numeric> caps=<hex_bitmask>
```

`<hex_bitmask>` carries a curated subset of bouncer-relevant caps,
NOT the full `cli_active_own` flagset.  Curation gives forward-compat
headroom (more bits allocated as needed) without leaking every CAP
addition into S2S noise.

### Defined bits (bouncer_session.h)

```c
#define BX_CAP_DRAFT_MULTILINE 0x01
#define BX_CAP_BATCH           0x02
```

Both must be set for BX M to be useful — multiline alone gives N
PRIVMSGs without the wrapper, batch alone has nothing to wrap.
Future bits (MSGTAGS, LABELEDRESP, ECHOMSG) are pre-reserved as
needed but not initially populated.

`ba_caps == 0` is ambiguous between "alias has no relevant caps" and
"we haven't received caps for this alias yet", so a separate
`ba_caps_known` flag bit on `BounceAlias` distinguishes them — see
below.

## Receiver side

### `BounceAlias` extension (bouncer_session.h)

```c
struct BounceAlias {
    char ba_numeric[6];
    unsigned int ba_caps;        /* BX_CAP_* bitmask */
    int  ba_caps_known;          /* set on first BX U caps= reception */
};
```

### `BX U` field handler

`bounce_alias_update` already has a field=value parser with branches
for `host=`, `realname=`, etc.  Add a `caps` branch:

```c
} else if (0 == ircd_strcmp(field, "caps")) {
    unsigned long caps = strtoul(value, NULL, 16);
    /* Walk the alias's account's sessions, find the matching
     * BounceAlias entry, update ba_caps + ba_caps_known. */
    ...
}
```

Update propagates via the existing `BX U` forward path so all servers
in the network converge on the same `ba_caps` value.

The existing `BX U` field-update code does its work on the alias's
local `Client*` struct (host, realname, etc.).  The `caps` field is
different — its target is the `BounceAlias` entry in the session
replica, not the `Client*` itself.  Walk all sessions for the alias's
account and update the matching entry.

## Sender side

### Cap-change hook (m_cap.c)

`cap_req`, `cap_ack`, and `cap_clear` already call
`bounce_recompute_session_caps(sptr)` after mutating `cli_active_own`.
That function is local-only; add a sibling `bounce_emit_alias_caps(sptr)`
that:

1. Returns silently if `sptr` is not a bouncer session participant
   (no account, or account has no session).
2. Computes the current `BX_CAP_*` bitmask from `cli_active_own`.
3. Emits `BX U <full_numeric> caps=<hex>` to all servers via
   `sendcmdto_serv_butone`.
4. Skips emission if the bitmask hasn't changed since last emit
   (avoids spam from CAP REQ/ACK that flips other caps not in our
   curated set).

The "skip if unchanged" optimisation needs per-client last-emitted
state.  Easiest: track in `cli_user(sptr)` or a small hash; or just
emit unconditionally — CAP REQ is rare enough that the chatter
isn't a real concern.  Lean toward unconditional emit for
implementation simplicity; revisit if telemetry shows churn.

### BX M dispatch (m_batch.c)

In the echo block, replace the `IsMultiline(cli_from(member))` gate
with a per-alias decision:

```c
} else {
    /* Remote alias.  Decide BX M vs BX E based on alias's caps. */
    int use_bxm;
    if (sender_sess->hs_aliases[i].ba_caps_known) {
        unsigned int caps = sender_sess->hs_aliases[i].ba_caps;
        use_bxm = (caps & BX_CAP_DRAFT_MULTILINE)
                  && (caps & BX_CAP_BATCH);
    } else {
        /* No caps info yet — fall back to link-level proxy. */
        use_bxm = IsMultiline(cli_from(member));
    }

    if (use_bxm) {
        emit_bxm_to_remote_member(...);
    } else {
        /* per-line BX E loop */
    }
}
```

Same shape for the `sender_primary` echo branch — but `sender_primary`
isn't in `hs_aliases[]`, so that path stays on `IsMultiline` proxy.
Tracking primary caps would need either a `BouncerSession` field or
extending `BX U` for the primary numeric (which works mechanically
since `bounce_alias_update` parses any numeric, but conceptually
primary isn't an alias).  Defer until/unless needed.

## Backward compatibility

- Old servers don't emit `BX U caps=`.  Their aliases stay
  `ba_caps_known == 0` on our side, fall through to the `IsMultiline`
  proxy.  No regression.
- Old servers receive `BX U caps=` and hit their existing "unknown
  field" debug log path.  Forward propagation still happens because
  `BX U`'s tail unconditionally re-broadcasts.  No regression.
- Mixed networks: caps converge slowly but correctly over the
  duration of a single client's CAP-change activity.  Initial state
  is established when the alias's home server processes the first
  cap reqack; before that, the alias is silently in the "unknown
  caps" fallback.

## Implementation slices

1. **Define BX_CAP_* + extend BounceAlias** (header-only).
2. **BX U receive caps= field** (bouncer_session.c).
3. **bounce_emit_alias_caps + cap-change hooks** (bouncer_session.c
   + m_cap.c).
4. **emit on bounce_alias_create's local-alias path** so newly-created
   aliases publish their initial caps.  Without this, aliases that
   never CAP REQ after creation would have `ba_caps_known == 0`
   forever.  Hook at the end of `bounce_alias_create` for the local
   alias case (sptr is the alias's home server == us).
5. **m_batch.c sender dispatch** uses `ba_caps_known` + `ba_caps`.

Each slice lands separately so we can confirm wire-format compat at
each step.

## Out of scope

- Primary cap discovery.  As noted above, primaries aren't tracked
  as aliases; their caps come from `cli_active_own` when local, or
  from the `IsMultiline` link proxy when remote.  Multi-connection
  bouncer sessions where the primary is on a different server from
  every alias are rare; revisit if it shows up.
- Cap propagation for non-bouncer use cases.  Other features that
  might benefit from per-client cap discovery (e.g., chathistory
  `event-playback` ramp) would warrant their own design — this plan
  is bouncer-local.
- Reducing emission churn.  CAP REQ is infrequent enough that
  unconditional emit is fine; can add change detection later if
  network telemetry shows the rate matters.
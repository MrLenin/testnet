# X3 channel-rename — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development
> (or executing-plans). Steps use checkbox syntax. Design + decisions of record:
> [[x3-channel-rename]] (read §1-§3, §8 before any task; §6/§7 are follow-on plans,
> NOT this one).

**Goal:** Registered-channel RENAME works end-to-end against X3, with the AC…R
stamp-poison fixed, X3's channel state following all renames, and legacy-server
safety enforced by a dynamic guard.

**Architecture:** X3 gains a `RenameChannel()` primitive + rename hook array
(mirroring the existing new/del channel hooks), an AC `R` rename-query branch that
authorizes against the access list (owner-only), and an `RN` handler that re-keys
live state. Nefarious restores the retained emit behind a new feature flag, adds the
legacy-services RN forward, and refuses RENAME while non-v3-aware non-service
servers are linked.

**Tech stack:** C (X3 master / nefarious fork branch), P10, Vitest E2E in `tests/`.

## Global constraints

- Wire shapes are FIXED by the retained ircd machinery — do not redesign:
  query `AC <unum> R <cookie> <#chan> RENAME <newname>`; approve `AC <cookie> A`;
  deny `AC <cookie> D :<reason>`; broadcast `RN <old> <new> :<reason>`.
  X3's reply puts the **cookie first** (NOT the LOC shape `AC <servnum> A <cookie>`) —
  nefarious `m_account.c:331` branches on parv[1] *failing* `FindNServer`.
- Rename authorization: access ≥ `UL_OWNER` (500); `_GetChannelUser` override
  semantics for staff; deny reasons are user-visible strings.
- X3 state moves ONLY on RN receipt, never at approve time.
- The old chanNode must stay alive until rename hooks have run (interior-pointer
  dict keys + pointer-compare holders — design doc §8).
- Legacy servers never receive RN except direct `IsService && !IsIRCv3Aware`
  downlinks.
- Never modify irctest files; targeted vitest runs only; rebuild BOTH nefarious
  images for cross-server tests; ask before committing/pushing
  (`feedback_no_overzealous_commits` — X3 work on a new branch
  `feature/channel-rename`).

---

### Task 1: `RenameChannel()` + rename hook array (X3 hash.c/hash.h)

**Files:** Modify `x3/src/hash.h` (near `reg_del_channel_func`, :441-446),
`x3/src/hash.c` (near `AddChannel`/`DelChannel`).

**Produces (later tasks rely on exact signatures):**
```c
typedef void (*channel_rename_func_t)(struct chanNode *old_chan,
                                      struct chanNode *new_chan, void *extra);
void reg_channel_rename_func(channel_rename_func_t handler, void *extra);
/* Returns the NEW node, or NULL (bad name / target exists). Old node freed. */
struct chanNode *RenameChannel(struct chanNode *channel, const char *new_name);
```

- [ ] **Step 1:** hook array plumbing in hash.c — copy the `dcf_list` pattern
  (static list + extra list + grow-on-register) as `crf_list`.
- [ ] **Step 2:** `RenameChannel`:

```c
struct chanNode *
RenameChannel(struct chanNode *channel, const char *new_name)
{
    struct chanNode *nNode;
    unsigned int n;

    if (!IsChannelName(new_name) || GetChannel(new_name))
        return NULL;
    nNode = calloc(1, sizeof(*nNode) + strlen(new_name));
    /* Copy the fixed head wholesale: modes, limit, LOCKS (inherited — chanserv
     * registration lock + alert/support locks count on this node), keys,
     * timestamp, topic, list headers (heap arrays move ownership), and the
     * channel_info pointer.  name[] is then overwritten. */
    memcpy(nNode, channel, sizeof(*channel));
    strcpy(nNode->name, new_name);
    for (n = 0; n < nNode->members.used; n++)
        nNode->members.list[n]->channel = nNode;
    /* Old node's dict key is an interior pointer into its name[] — remove
     * while it is still alive. */
    dict_remove(channels, channel->name);
    dict_insert(channels, nNode->name, nNode);
    /* Modules re-point their own holders (design doc §8) with BOTH nodes
     * alive: pointer-compare holders need old; name-keyed dicts need
     * old->name intact. */
    for (n = 0; n < crf_used; n++)
        crf_list[n](channel, nNode, crf_list_extra[n]);
    free(channel);
    return nNode;
}
```

- [ ] **Step 3:** build (`cd x3 && make` or the docker build) — clean compile, no
  callers yet.
- [ ] **Step 4:** commit on `feature/channel-rename`.

### Task 2: module rename hooks (X3)

**Files:** Modify `x3/src/chanserv.c`, `opserv.c`, `spamserv.c`,
`mod-helpserv.c`, `mod-snoop.c`, `mod-track.c`, `mod-blacklist.c` — each
registers one hook in its init function, next to its existing
`reg_del_channel_func` call.

**Consumes:** Task 1 signatures. Holder inventory is design doc §8 — implement
exactly that list, nothing else.

- [ ] **Step 1 — chanserv hook:** `new_chan->channel_info->channel = new_chan`
  (if set); walk `adduser_pendings` (chanserv.c:609) re-pointing
  `->channel == old_chan`; walk `chanserv_conf.support_channels` swapping the
  pointer.
- [ ] **Step 2 — opserv hook:** compare-swap `opserv_conf.debug_channel /
  alert_channel / staff_auth_channel`; iterate `opserv_user_alerts` re-pointing
  `discrim->channels[0..channel_count)`; `timeq_del(0, opserv_part_channel,
  old_chan, TIMEQ_IGNORE_WHEN|TIMEQ_IGNORE_FUNC)` per the
  `opserv_channel_delete` template (opserv.c:2986-2990) — do NOT re-add (the
  purge-lock re-evaluates); recompute `new_chan->bad_channel =
  opserv_bad_channel(new_chan->name)`.
- [ ] **Step 3 — spamserv hook:** follow the existing move/merge pattern at
  `spamserv.c:368-371` (`spamserv_cs_move_merge`) for the chanInfo re-point +
  `registered_channels_dict` re-key; walk connected users' `spam`/`flood`/
  `joinflood` node chains re-pointing `->channel` (renames are rare; bounded by
  user count).
- [ ] **Step 4 — helpserv hook:** iterate `helpserv_bots_dict`: `hs->helpchan`
  and every `page_targets[i]`; re-key `helpserv_bots_bychan_dict`
  (dict_remove with old interior key BEFORE the old node dies is already
  guaranteed by hook ordering; re-insert keyed `hs->helpchan->name` after
  re-point).
- [ ] **Step 5 — snoop/track/blacklist hooks:** single compare-swap of each
  conf slot.
- [ ] **Step 6:** build; commit.

### Task 3: AC `R` disambiguation + rename authorization (X3)

**Files:** Modify `x3/src/proto-p10.c` (`cmd_account`, :1733 region),
`x3/src/chanserv.c` + `chanserv.h` (new export).

**Produces:**
```c
/* chanserv.h — returns 1 = allow; 0 = deny with *reason set to a static string */
int chanserv_rename_allowed(struct userNode *user, struct chanNode *chan,
                            const char *new_name, const char **reason);
```

- [ ] **Step 1 — chanserv_rename_allowed** (chanserv.c): deny if
  `!user->handle_info`; allow if `!chan->channel_info` (nothing to protect —
  don't trust the asker's +R view); deny if `IsProtected(cData)` /
  `IsSuspended(cData)`; `uData = _GetChannelUser(cData, hi, 1, 0)` — deny if
  `!uData || uData->access < UL_OWNER`; deny if `opserv_bad_channel(new_name)`;
  deny if `GetChannel(new_name) && GetChannel(new_name)->channel_info`; deny on
  DNR: the owner-loop from `cmd_move` (chanserv.c:2777) against `new_name`.
- [ ] **Step 2 — cmd_account branch** (proto-p10.c):

```c
else if(!strcmp(argv[2],"R")) {
    if(argc >= 7 && !strcmp(argv[5],"RENAME")) {
        /* Rename permission query: AC <unum> R <cookie> <#chan> RENAME <new>.
         * Reply shape: cookie FIRST (ircd m_account.c keys pending renames on
         * parv[1] not being a server numeric). Never GetUserN() the cookie. */
        const char *reason = "Permission denied";
        struct chanNode *chan = GetChannel(argv[4]);
        if(user && chan && chanserv_rename_allowed(user, chan, argv[6], &reason))
            putsock("%s " P10_ACCOUNT " %s A", self->numeric, argv[3]);
        else
            putsock("%s " P10_ACCOUNT " %s D :%s", self->numeric, argv[3], reason);
        return 1;
    }
    call_account_func(user, argv[3]);   /* legacy account stamp — unchanged */
}
```
  Note `user` here is `GetUserN(argv[1])` from the existing prologue — the
  requester's numeric, which is the correct lookup for the rename branch too.
- [ ] **Step 3:** build; commit.

### Task 4: RN handler (X3)

**Files:** Modify `x3/src/proto-p10.c` (defines near :29/:130, `init_parse`
near :2831).

(The `WP B` spam was an ircd bug, fixed emitter-side in s_serv.c — no X3 `WP`
dummy; receiver-side masking would hide the next emitter bug.)

- [ ] **Step 1:** `#define CMD_RENAME "RENAME"`, `#define TOK_RENAME "RN"`.
- [ ] **Step 2:** `cmd_rename`:

```c
static CMD_FUNC(cmd_rename)
{
    struct chanNode *chan;
    if(argc < 3) return 0;
    if(!(chan = GetChannel(argv[1]))) return 1;   /* never knew it; nothing to move */
    if(GetChannel(argv[2])) {
        log_module(MAIN_LOG, LOG_ERROR,
                   "RENAME %s -> %s: target already exists, state diverged",
                   argv[1], argv[2]);
        return 1;
    }
    RenameChannel(chan, argv[2]);
    return 1;
}
```
  State migration is authorize-at-query, apply-at-RN (design §3a) — no chanserv
  logic here.
- [ ] **Step 3:** register in `init_parse`: `RENAME`/`RN` → `cmd_rename`.
- [ ] **Step 4:** timed DNR on the old name (§6 synergy): in `cmd_rename`, when
  the renamed channel had `channel_info`, add an expiring DNR on `argv[1]`
  reusing chanserv's DNR machinery (`chanserv_add_dnr`-equivalent internals used
  by `cmd_noregister`; expiry = a new `rename_dnr_duration` chanserv conf key,
  default 86400, 0 = off). If the internals don't export cleanly, add
  `chanserv_rename_dnr(const char *old_name)` in chanserv.c and call that.
- [ ] **Step 5:** build; commit.

### Task 5: nefarious — feature flag, emit restore, dynamic guard, legacy forward

**Files:** Modify `nefarious/include/ircd_features.h` (enum near
FEAT_REGISTER_SERVER), `nefarious/ircd/ircd_features.c` (:1210 region),
`nefarious/ircd/m_rename.c`.

- [ ] **Step 1:** `F_B(RENAME_SERVICES, 0, 0, 0)` + enum entry — default OFF so
  every existing deployment keeps today's honest refusal.
- [ ] **Step 2 — dynamic guard** (m_rename.c, static helper):

```c
/* RENAME is only sound when every server can apply RN.  Legacy servers
 * neither relay nor apply unknown tokens (design doc §2), so refuse while
 * any non-v3-aware, non-service server is linked.  Services are exempt:
 * they get the targeted forward below. */
static struct Client *rename_legacy_blocker(void)
{
  struct Client *acptr;
  for (acptr = GlobalClientList; acptr; acptr = cli_next(acptr))
    if (IsServer(acptr) && !IsIRCv3Aware(acptr) && !IsService(acptr))
      return acptr;
  return NULL;
}
```
  Call it in `m_rename` after the name-validation block, before BOTH the
  registered and unregistered paths:
  `send_fail(sptr, "RENAME", "CANNOT_RENAME", oldname, "A linked server does
  not support channel rename");` — this also fixes the pre-existing
  unregistered-rename divergence bug. Do NOT guard `ms_rename` (a remote
  server already executed it; refusing locally would diverge us instead).
- [ ] **Step 3 — legacy-services forward** (static helper): after every
  `sendcmdto_serv_butone_v3(..., CMD_RENAME, ...)` site (`m_rename`
  unregistered path, `pending_rename_complete`, and `ms_rename`'s
  re-propagation), walk `cli_serv(&me)->down`; for each downlink with
  `!IsIRCv3Aware && IsService` (skipping the direction the message came from)
  `sendcmdto_one(sptr, CMD_RENAME, cptr, "%s %s :%s", old, new, reason)`.
- [ ] **Step 4 — emit restore** in the registered branch, replacing the
  unconditional refusal:

```c
  if (chptr->mode.mode & MODE_REGISTERED) {
    struct Client *services;
    struct PendingRename *pr;
    if (!feature_bool(FEAT_RENAME_SERVICES)) {
      send_fail(sptr, "RENAME", "CANNOT_RENAME", oldname,
                "Renaming a registered channel requires services support, "
                "which is unavailable");
      return 0;
    }
    if (!(services = find_services_server())) {
      send_fail(sptr, "RENAME", "TEMPORARILY_UNAVAILABLE", oldname,
                "Registration service is not available");
      return 0;
    }
    if (!(pr = pending_rename_add(sptr, chptr, newname, reason))) {
      send_fail(sptr, "RENAME", "TEMPORARILY_UNAVAILABLE", oldname,
                "Too many renames in progress");
      return 0;
    }
    sendcmdto_one(&me, CMD_ACCOUNT, services, "%C R %u %s RENAME %s",
                  sptr, pr->cookie, chptr->chname, newname);
    return 0;
  }
```
  (Keep the big protocol-history comment, updated: the collision is now
  disambiguated services-side; the flag records which builds may be asked.
  Match `pending_rename_add`'s real signature when implementing.)
- [ ] **Step 5:** host build clean; commit.

### Task 6: deploy + wire verification

- [ ] **Step 1:** `scripts/dc.sh build x3 nefarious nefarious2` then `up -d`
  those services (both nefarious images per
  `project_dc_rebuild_both_servers`).
- [ ] **Step 2:** flip `"RENAME_SERVICES" = "TRUE"` in `data/ircd.conf` +
  `data/ircd2.conf` only (guard scope: bed's other confs belong to the crdt
  fleet — out of scope for this branch).
- [ ] **Step 3:** wire check with `scripts/irc-test.sh` / a gate script:
  oper client, registered channel, RENAME → observe `AC … R … RENAME` and
  `AC <cookie> A` + `RN` in the S2S debug log; confirm X3's
  `ChanServ INFO #new` shows the registration and `everything.log` has no
  PARSE ERROR for RN.

### Task 7: vitest E2E (tests/)

**Files:** Create `tests/src/ircv3/channel-rename-services.test.ts` (patterns:
`test-writing` skill, `createX3Client` helpers).

- [ ] **Step 1:** write the suite — cases from design §4:
  1. owner renames registered channel → RENAME succeeds; `ChanServ INFO #new`
     registered; `INFO #old` not; access list intact (`ChanServ ACCESS`).
  2. non-owner (op-level access) → FAIL with X3's deny reason.
  3. rename onto a registered name → deny.
  4. unregistered channel rename with X3 linked → X3 follows
     (ChanServ `op` on #new works post-rename).
  5. stamp-poison regression: after a denied rename attempt, the same client
     can still AUTH successfully (the old bug silently discarded the stamp).
  6. old name re-registration blocked while the timed DNR stands
     (`ChanServ REGISTER #old` → DNR refusal), if Task 4 Step 4 landed.
- [ ] **Step 2:** `IRC_HOST=localhost npm test -- src/ircv3/channel-rename-services.test.ts`
  → all green.
- [ ] **Step 3:** commit tests; STOP — ask the user before any push / PR
  creation (X3 PR rides with the queued #56 review, design doc §9).

## Deliberate exclusions (recorded, not dropped)

- §6 redirect tombstone + §7 history chain/fence: follow-on plans (interim
  behaviour = history discontinuity, per design sequencing note).
- Upstream backport (full RN application on evilnet/nefarious2): tracked
  follow-on, own plan (design §2 decision 3).
- crdt-mesh branch: rename-on-mesh needs its own design (design §7 last bullet).
- X3-side unit tests: no harness exists; coverage is the vitest suite.

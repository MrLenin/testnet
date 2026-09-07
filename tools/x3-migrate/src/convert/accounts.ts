/**
 * Converter part A — account authority (x3-merge-sequencing.md §4, Phase 1).
 *
 * Joins X3's saxdb NickServ section with a Keycloak user enumeration and emits
 * the daemon's Account rows plus the name->uuid secondary index, per
 * x3-merge-authority-model.md §1.1.
 *
 * Why the join key is the Keycloak subject UUID and not the LDAP entryUUID:
 * under D1 federation Keycloak stores BOTH (its own minted `id`, and `LDAP_ID`
 * holding the directory's entryUUID). At stage 2 the directory retires, taking
 * LDAP_ID with it while the Keycloak id persists. Keying accounts on entryUUID
 * would anchor the store to the one identifier scheduled for deletion.
 *
 * Why matching is by NAME even though the whole point is to stop keying on
 * names: the migration is the last moment the name->identity mapping is still
 * authoritative and verifiable. Establishing the UUID binding here is what lets
 * everything afterwards stop trusting names.
 */
import { ircFold, ogetObj, ogetStr, type RObject } from '../recdb/model.js';

/** A row from a Keycloak admin-REST user enumeration, taken after a full federation sync. */
export interface KeycloakUser {
  /** `kc_user.id` — the Account primary key. Minted by Keycloak, survives directory retirement. */
  id: string;
  username: string;
  email?: string;
  /** `LDAP_ID` attribute: the directory entryUUID. Provenance only — never a key. */
  ldapId?: string;
}

/** Daemon Account record (authority model §1.1). */
export interface AcctRow {
  uuid: string;
  name: string;
  /** Parsed registration time. */
  registeredTs: number;
  /**
   * The saxdb bytes exactly as written. §2's seam fact requires `registered` to
   * survive byte-identical into `acc_create` for residual X3, so the raw form is
   * carried rather than reconstructed from the parsed value.
   */
  registeredRaw: string;
  email?: string;
  opservLevel: number;
  flags: string;
  lastSeen?: number;
  ldapId?: string;
  schemaVersion: number;
}

export type QuarantineReason =
  | 'no-keycloak-user'
  | 'duplicate-keycloak-match'
  | 'malformed-record';

export interface QuarantinedAccount {
  handle: string;
  reason: QuarantineReason;
  opservLevel: number;
  lastSeen?: number;
  /** Set when the handle holds a ChanServ user record — distinguishes a live orphan from a dead one. */
  hasChannelAccess: boolean;
  detail?: string;
}

export interface ConvertResult {
  accounts: AcctRow[];
  byName: Array<{ name: string; uuid: string }>;
  quarantined: QuarantinedAccount[];
  /** Keycloak usernames with no X3 handle. Not an error — reported, never silently dropped. */
  keycloakOnly: string[];
  anomalies: string[];
}

export interface ConvertOptions {
  chanserv?: RObject | null;
  schemaVersion?: number;
}

const SCHEMA_VERSION = 1;

/**
 * Every account (IRC-folded) holding a ChanServ access record anywhere.
 *
 * Used to annotate quarantine entries: an orphaned handle with channel access is
 * a live problem, one without is inert. The expected legitimate orphan is a
 * break-glass admin account deliberately kept out of the directory.
 */
export function accountsWithChannelAccess(chanserv: RObject | null | undefined): Set<string> {
  const held = new Set<string>();
  if (!chanserv) return held;
  const channels = ogetObj(chanserv, 'channels');
  if (!channels) return held;
  for (const [, chan] of channels.entries) {
    if (chan.kind !== 'object') continue;
    const users = ogetObj(chan, 'users');
    if (!users) continue;
    for (const [account] of users.entries) held.add(ircFold(account));
  }
  return held;
}

export function convertAccounts(
  nickserv: RObject,
  kcUsers: KeycloakUser[],
  opts: ConvertOptions = {},
): ConvertResult {
  const schemaVersion = opts.schemaVersion ?? SCHEMA_VERSION;
  const withAccess = accountsWithChannelAccess(opts.chanserv);

  // Fold the Keycloak enumeration. A fold collision means two Keycloak users
  // differing only by case claim the same X3 handle; that is not resolvable
  // here, so both are recorded and the handle is quarantined rather than
  // silently bound to whichever came first.
  const byFold = new Map<string, KeycloakUser[]>();
  for (const u of kcUsers) {
    const k = ircFold(u.username);
    const bucket = byFold.get(k);
    if (bucket) bucket.push(u);
    else byFold.set(k, [u]);
  }

  const accounts: AcctRow[] = [];
  const quarantined: QuarantinedAccount[] = [];
  const anomalies: string[] = [];
  const matchedFolds = new Set<string>();

  for (const [handle, value] of nickserv.entries) {
    const fold = ircFold(handle);

    if (value.kind !== 'object') {
      // Same rule the census applies: nothing is skipped without being named.
      anomalies.push(`NickServ: record "${handle}" is a ${value.kind}, not an object — not converted`);
      continue;
    }

    const opservLevel = Number.parseInt(ogetStr(value, 'opserv_level') ?? '0', 10) || 0;
    const lastSeenRaw = ogetStr(value, 'lastseen');
    const lastSeen = lastSeenRaw === undefined ? undefined : Number.parseInt(lastSeenRaw, 10);
    const hasChannelAccess = withAccess.has(fold);
    const quarantine = (reason: QuarantineReason, detail?: string) => {
      quarantined.push({
        handle,
        reason,
        opservLevel,
        lastSeen: Number.isFinite(lastSeen) ? lastSeen : undefined,
        hasChannelAccess,
        detail,
      });
    };

    // `register` (nickserv.c KEY_REGISTER_ON), NOT `registered` -- that is the
    // ChanServ channel key (chanserv.c KEY_REGISTERED). Reading the wrong one
    // yields undefined for every account.
    const registeredRaw = ogetStr(value, 'register');
    const registeredTs = registeredRaw === undefined ? NaN : Number.parseInt(registeredRaw, 10);
    if (registeredRaw === undefined || !Number.isFinite(registeredTs)) {
      anomalies.push(
        `NickServ: account "${handle}" has ${registeredRaw === undefined ? 'no' : 'an unparsable'} "register" value` +
          (registeredRaw === undefined ? '' : ` (${registeredRaw})`),
      );
      quarantine('malformed-record', 'registration timestamp missing or unparsable');
      continue;
    }

    const candidates = byFold.get(fold);
    if (!candidates || candidates.length === 0) {
      quarantine('no-keycloak-user');
      continue;
    }
    matchedFolds.add(fold);
    if (candidates.length > 1) {
      quarantine(
        'duplicate-keycloak-match',
        `Keycloak ids ${candidates.map(c => c.id).join(', ')} all fold to "${fold}"`,
      );
      continue;
    }

    const kc = candidates[0]!;
    accounts.push({
      uuid: kc.id,
      name: fold,
      registeredTs,
      registeredRaw,
      email: kc.email ?? ogetStr(value, 'email'),
      opservLevel,
      flags: ogetStr(value, 'flags') ?? '',
      lastSeen: Number.isFinite(lastSeen) ? lastSeen : undefined,
      ldapId: kc.ldapId,
      schemaVersion,
    });
  }

  const keycloakOnly = kcUsers
    .filter(u => !matchedFolds.has(ircFold(u.username)))
    .map(u => u.username);

  return {
    accounts,
    byName: accounts.map(a => ({ name: a.name, uuid: a.uuid })),
    quarantined,
    keycloakOnly,
    anomalies,
  };
}

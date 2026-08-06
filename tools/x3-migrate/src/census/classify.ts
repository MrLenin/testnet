import { RObject, ircFold, ogetStr } from '../recdb/model.js';
import { LdapAccount } from '../ldif.js';

export type CredState = 'ldap-backed' | 'local-hash-only' | 'both' | 'neither';
export type HashFormat = 'plain-md5' | 'seeded' | 'malformed' | 'absent';
export type ActivityBucket = '<30d' | '<180d' | '<1y' | '<5y' | 'older' | 'unknown';

export interface AccountCensus {
  handle: string;
  credState: CredState;
  hashFormat: HashFormat;
  activity: ActivityBucket;
  anomalies: string[];
}

const PLAIN_LOWER_RE = /^[0-9a-f]{32}$/;
const PLAIN_ANY_CASE_RE = /^[0-9a-fA-F]{32}$/;
const SEEDED_RE = /^\$([0-9a-fA-F]{8})([0-9a-fA-F]{32})$/;

/**
 * Classify a NickServ `passwd` field's hash shape.
 *
 * X3 writes seeded digests uppercase and plain digests lowercase (md5.c), so
 * case deviation from that convention is a misdetection signal, not something
 * to silently normalize — it's surfaced as an anomaly alongside the format.
 */
export function classifyHash(passwd: string | undefined): { format: HashFormat; anomalies: string[] } {
  const anomalies: string[] = [];
  if (!passwd) return { format: 'absent', anomalies };

  if (PLAIN_LOWER_RE.test(passwd)) return { format: 'plain-md5', anomalies };

  if (PLAIN_ANY_CASE_RE.test(passwd)) {
    // 32 hex chars but not the all-lowercase form X3 writes for plain hashes.
    anomalies.push('plain-hash-uppercase');
    return { format: 'malformed', anomalies };
  }

  if (passwd.startsWith('$')) {
    const m = SEEDED_RE.exec(passwd);
    if (!m) return { format: 'malformed', anomalies };
    const digest = m[2]!;
    if (/[a-f]/.test(digest)) anomalies.push('seeded-hash-lowercase');
    return { format: 'seeded', anomalies };
  }

  return { format: 'malformed', anomalies };
}

const DAY = 86400;

/** Parse a decimal epoch-seconds string and bucket its age against `now`. Unparsable/absent -> 'unknown'. */
export function activityBucket(lastseenEpochStr: string | undefined, now: number): ActivityBucket {
  if (lastseenEpochStr === undefined) return 'unknown';
  const trimmed = lastseenEpochStr.trim();
  if (!/^\d+$/.test(trimmed)) return 'unknown';
  const t = parseInt(trimmed, 10);
  const ageDays = (now - t) / DAY;
  if (ageDays < 30) return '<30d';
  if (ageDays < 180) return '<180d';
  if (ageDays < 365) return '<1y';
  if (ageDays < 1825) return '<5y';
  return 'older';
}

/**
 * Classify every NickServ handle against optional LDAP account data.
 *
 * CredState keys on credential-material PRESENCE, not parsability: a
 * non-empty `passwd` counts as local material even when classifyHash finds
 * it malformed — the malformation surfaces via hashFormat + anomalies, never
 * by silently reclassifying the account as 'neither' (which would hide it
 * from credential-migration planning).
 */
export function classifyAccounts(nickserv: RObject, ldap: LdapAccount[] | null, now: number): AccountCensus[] {
  const ldapFolds = ldap === null ? null : new Set(ldap.map(a => ircFold(a.uid)));

  const out: AccountCensus[] = [];
  for (const [handle, value] of nickserv.entries) {
    if (value.kind !== 'object') continue;
    const passwd = ogetStr(value, 'passwd');
    const lastseen = ogetStr(value, 'lastseen');

    const { format: hashFormat, anomalies: hashAnomalies } = classifyHash(passwd);
    const activity = activityBucket(lastseen, now);
    const hasLocalMaterial = passwd !== undefined && passwd.length > 0;
    const hasLdap = ldapFolds !== null && ldapFolds.has(ircFold(handle));

    let credState: CredState;
    if (ldapFolds === null) {
      credState = hasLocalMaterial ? 'local-hash-only' : 'neither';
    } else if (hasLocalMaterial && hasLdap) {
      credState = 'both';
    } else if (hasLocalMaterial) {
      credState = 'local-hash-only';
    } else if (hasLdap) {
      credState = 'ldap-backed';
    } else {
      credState = 'neither';
    }

    const anomalies: string[] = [];
    if (hashFormat === 'malformed') anomalies.push(`${handle}: malformed passwd`);
    for (const a of hashAnomalies) anomalies.push(`${handle}: ${a}`);

    out.push({ handle, credState, hashFormat, activity, anomalies });
  }
  return out;
}

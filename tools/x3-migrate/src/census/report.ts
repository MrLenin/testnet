import { RObject, ircFold, ogetObj, ogetStr } from '../recdb/model.js';
import { ParseResult } from '../recdb/parse.js';
import { LdapAccount } from '../ldif.js';
import { AccountCensus, ActivityBucket, classifyAccounts, CredState, HashFormat } from './classify.js';

export interface CensusReport {
  generatedAt: string; // ISO, caller-supplied clock
  ldifSupplied: boolean;
  sections: Record<string, number>; // top-level section name -> record count (1 level down)
  accounts: {
    total: number;
    byCredState: Record<CredState, number>;
    byHashFormat: Record<HashFormat, number>;
    activityByCredState: Record<CredState, Record<ActivityBucket, number>>;
  };
  chanserv: { channels: number; userRecords: number; banRecords: number };
  danglingRefs: { kind: 'owner' | 'users-key' | 'ban-owner' | 'ldap-only-uid'; channel?: string; name: string }[];
  anomalies: string[]; // flat, human-readable, includes parser diagnostics
  clean: boolean; // danglingRefs empty AND anomalies empty
}

const CRED_STATES: CredState[] = ['ldap-backed', 'local-hash-only', 'both', 'neither'];
const HASH_FORMATS: HashFormat[] = ['plain-md5', 'seeded', 'malformed', 'absent'];
const ACTIVITY_BUCKETS: ActivityBucket[] = ['<30d', '<180d', '<1y', '<5y', 'older', 'unknown'];

function zeroRecord<K extends string>(keys: K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  return out;
}

type DanglingRef = CensusReport['danglingRefs'][number];

export function buildReport(parse: ParseResult, ldap: LdapAccount[] | null, now: number): CensusReport {
  const root = parse.root;
  const anomalies: string[] = [];

  // -- sections: every top-level section name -> its entry count (unmodeled sections included) --
  const sections: Record<string, number> = {};
  for (const [name, value] of root.entries) {
    if (value.kind === 'object') {
      sections[name] = value.entries.size;
    } else {
      sections[name] = 0;
      anomalies.push(`top-level non-object section ${name}`);
    }
  }

  // -- accounts --
  const nickserv = ogetObj(root, 'NickServ') ?? { kind: 'object', entries: new Map() } as RObject;
  const accounts: AccountCensus[] = classifyAccounts(nickserv, ldap, now);

  const byCredState = zeroRecord(CRED_STATES);
  const byHashFormat = zeroRecord(HASH_FORMATS);
  const activityByCredState = {} as Record<CredState, Record<ActivityBucket, number>>;
  for (const cs of CRED_STATES) activityByCredState[cs] = zeroRecord(ACTIVITY_BUCKETS);

  const handleFolds = new Set<string>();
  for (const a of accounts) {
    byCredState[a.credState]++;
    byHashFormat[a.hashFormat]++;
    activityByCredState[a.credState][a.activity]++;
    for (const msg of a.anomalies) anomalies.push(msg);
    handleFolds.add(ircFold(a.handle));
  }

  // -- ChanServ sweep --
  const danglingRefs: DanglingRef[] = [];
  let channels = 0;
  let userRecords = 0;
  let banRecords = 0;

  const chanserv = ogetObj(root, 'ChanServ');
  if (chanserv) {
    for (const [chanName, chanValue] of chanserv.entries) {
      if (chanValue.kind !== 'object') continue;
      channels++;

      const owner = ogetStr(chanValue, 'owner');
      if (owner !== undefined && !handleFolds.has(ircFold(owner))) {
        danglingRefs.push({ kind: 'owner', channel: chanName, name: owner });
      }

      const users = ogetObj(chanValue, 'users');
      if (users) {
        for (const [uname] of users.entries) {
          userRecords++;
          if (!handleFolds.has(ircFold(uname))) {
            danglingRefs.push({ kind: 'users-key', channel: chanName, name: uname });
          }
        }
      }

      const bans = ogetObj(chanValue, 'bans');
      if (bans) {
        for (const [, banValue] of bans.entries) {
          if (banValue.kind !== 'object') continue;
          banRecords++;
          const banOwner = ogetStr(banValue, 'owner');
          if (banOwner !== undefined && !handleFolds.has(ircFold(banOwner))) {
            danglingRefs.push({ kind: 'ban-owner', channel: chanName, name: banOwner });
          }
        }
      }
    }
  }

  // -- LDAP-only uids (LDIF supplied, no matching handle) --
  if (ldap !== null) {
    for (const acc of ldap) {
      if (!handleFolds.has(ircFold(acc.uid))) {
        danglingRefs.push({ kind: 'ldap-only-uid', name: acc.uid });
      }
    }
  }

  // -- parser diagnostics fold into anomalies --
  for (const d of parse.diagnostics) {
    anomalies.push(`parse: ${d.kind} at ${d.line}:${d.col} ${d.detail}`);
  }

  return {
    generatedAt: new Date(now * 1000).toISOString(),
    ldifSupplied: ldap !== null,
    sections,
    accounts: {
      total: accounts.length,
      byCredState,
      byHashFormat,
      activityByCredState,
    },
    chanserv: { channels, userRecords, banRecords },
    danglingRefs,
    anomalies,
    clean: danglingRefs.length === 0 && anomalies.length === 0,
  };
}

export function renderReport(r: CensusReport): string {
  const lines: string[] = [];

  lines.push(
    r.clean
      ? '=== CENSUS: GO ==='
      : `=== CENSUS: NO-GO (${r.anomalies.length} anomalies, ${r.danglingRefs.length} dangling refs) ===`,
  );
  lines.push('');
  lines.push(`generated: ${r.generatedAt}`);
  lines.push(`ldif supplied: ${r.ldifSupplied}`);
  lines.push('');

  lines.push('-- sections --');
  for (const [name, count] of Object.entries(r.sections)) lines.push(`  ${name}: ${count}`);
  lines.push('');

  lines.push('-- accounts --');
  lines.push(`  total: ${r.accounts.total}`);
  lines.push('  by credState:');
  for (const [k, v] of Object.entries(r.accounts.byCredState)) lines.push(`    ${k}: ${v}`);
  lines.push('  by hashFormat:');
  for (const [k, v] of Object.entries(r.accounts.byHashFormat)) lines.push(`    ${k}: ${v}`);
  lines.push('  activity by credState:');
  for (const [cs, buckets] of Object.entries(r.accounts.activityByCredState)) {
    const row = Object.entries(buckets).map(([b, n]) => `${b}=${n}`).join(' ');
    lines.push(`    ${cs}: ${row}`);
  }
  lines.push('');

  lines.push('-- chanserv --');
  lines.push(`  channels: ${r.chanserv.channels}`);
  lines.push(`  userRecords: ${r.chanserv.userRecords}`);
  lines.push(`  banRecords: ${r.chanserv.banRecords}`);
  lines.push('');

  lines.push('-- dangling refs --');
  if (r.danglingRefs.length === 0) {
    lines.push('  (none)');
  } else {
    for (const d of r.danglingRefs) {
      lines.push(`  ${d.kind}${d.channel ? ' in ' + d.channel : ''}: ${d.name}`);
    }
  }
  lines.push('');

  lines.push('-- anomalies --');
  if (r.anomalies.length === 0) {
    lines.push('  (none)');
  } else {
    for (const a of r.anomalies) lines.push(`  ${a}`);
  }

  return lines.join('\n');
}

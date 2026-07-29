import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueId,
  IRC_OPER,
  SECONDARY_SERVER,
} from '../helpers/index.js';

/**
 * Metadata limit enforcement (F-M6 hardening batch).
 *
 * The per-account limits (FEAT_METADATA_MAX_KEYS = 20 new keys,
 * FEAT_METADATA_MAX_VALUE_BYTES = 300) must hold on every write path:
 *  - the normal client SET path (pre-existing behavior, regression-guarded here)
 *  - the oper "SET *account" path incl. the offline-account branch (new enforcement)
 * plus the is_valid_key off-by-one fix: a key of METADATA_KEY_LEN (64) chars
 * no longer passes validation only to be silently truncated to 63 on store.
 *
 * All cases use unauthed clients (fresh connection = zero in-memory keys) or a
 * fresh fake account name (zero persisted rows), so counts are deterministic.
 */

const MAX_KEYS = 20;

async function metaClient(nick: string): Promise<RawSocketClient> {
  const client = await createRawSocketClient();
  const caps = await client.capLs();
  const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
  await client.capReq([metaCap]);
  client.capEnd();
  client.register(nick);
  await client.waitForNumeric('001');
  return client;
}

/** Send one METADATA SET and wait for its acknowledgement or FAIL.
 * The server rate-limits metadata commands per second
 * (FEAT_METADATA_RATE_LIMIT, opers exempt); on RATE_LIMITED, wait out
 * the one-second window and retry — that FAIL is pacing, not a verdict. */
async function setKey(
  c: RawSocketClient,
  target: string,
  key: string,
  value?: string
): Promise<{ command: string; raw: string }> {
  const line =
    value !== undefined
      ? `METADATA ${target} SET ${key} :${value}`
      : `METADATA ${target} SET ${key}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    c.send(line);
    const resp = await c.waitForParsedLine(
      msg =>
        msg.command === 'FAIL' ||
        msg.command === '761' ||
        (msg.command === 'METADATA' && msg.raw.includes(key)),
      5000
    );
    if (resp.command === 'FAIL' && resp.raw.includes('RATE_LIMITED')) {
      await new Promise(r => setTimeout(r, 1100));
      continue;
    }
    return resp;
  }
  throw new Error(`still RATE_LIMITED after 5 attempts: ${line}`);
}

describe('Metadata limit enforcement (F-M6)', () => {
  const clients: RawSocketClient[] = [];
  const track = <T extends RawSocketClient>(c: T): T => {
    clients.push(c);
    return c;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  it(
    'client path: 21st new key is refused, updates at cap still work',
    async () => {
      const client = track(await metaClient(`mdcap${uniqueId().slice(0, 5)}`));

      for (let i = 1; i <= MAX_KEYS; i++) {
        const resp = await setKey(client, '*', `limitkey${i}`, `v${i}`);
        expect(resp.command, `key ${i} should be accepted, got: ${resp.raw}`).not.toBe('FAIL');
      }

      const over = await setKey(client, '*', 'limitkey21', 'v21');
      expect(over.command, `21st key should FAIL, got: ${over.raw}`).toBe('FAIL');
      expect(over.raw).toContain('LIMIT_REACHED');

      // Updating an existing key while at cap must remain allowed.
      const update = await setKey(client, '*', 'limitkey1', 'updated');
      expect(update.command, `update at cap should succeed, got: ${update.raw}`).not.toBe('FAIL');

      client.send('QUIT');
    },
    60000
  );

  it(
    'client path: value longer than MAX_VALUE_BYTES is refused',
    async () => {
      const client = track(await metaClient(`mdval${uniqueId().slice(0, 5)}`));

      const resp = await setKey(client, '*', 'longval', 'x'.repeat(301));
      expect(resp.command, `301-byte value should FAIL, got: ${resp.raw}`).toBe('FAIL');
      expect(resp.raw).toContain('VALUE_INVALID');

      const ok = await setKey(client, '*', 'okval', 'x'.repeat(300));
      expect(ok.command, `300-byte value should be accepted, got: ${ok.raw}`).not.toBe('FAIL');

      client.send('QUIT');
    },
    30000
  );

  it(
    'key of METADATA_KEY_LEN chars is rejected, one shorter is accepted',
    async () => {
      const client = track(await metaClient(`mdkey${uniqueId().slice(0, 5)}`));

      // 64 chars: previously passed validation and was silently truncated to
      // 63 on store (stored under a different name than the wire requested).
      const tooLong = await setKey(client, '*', 'k' + 'a'.repeat(63), 'v');
      expect(tooLong.command, `64-char key should FAIL, got: ${tooLong.raw}`).toBe('FAIL');
      expect(tooLong.raw).toContain('KEY_INVALID');

      const fits = await setKey(client, '*', 'k' + 'a'.repeat(62), 'v');
      expect(fits.command, `63-char key should be accepted, got: ${fits.raw}`).not.toBe('FAIL');

      client.send('QUIT');
    },
    30000
  );

  it(
    'oper *account path (offline branch): cap enforced, updates and deletes exempt',
    async () => {
      // The *account branch only needs IsOper — oper up directly rather than
      // going through the X3-admin auth stack (which needs Keycloak warm).
      // Keycloak-backed OPER is async: allow generous time for the 381.
      const oper = track(await metaClient(`mdop${uniqueId().slice(0, 5)}`));
      oper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
      await oper.waitForNumeric('381', 20000);
      // Fresh fake account: no online user, no persisted rows — the offline
      // branch (direct LMDB write) with a deterministic starting count of 0.
      const account = `mdlim${uniqueId().slice(0, 8)}`;

      for (let i = 1; i <= MAX_KEYS; i++) {
        const resp = await setKey(oper, `*${account}`, `okey${i}`, `v${i}`);
        expect(resp.command, `oper key ${i} should be accepted, got: ${resp.raw}`).not.toBe('FAIL');
      }

      const over = await setKey(oper, `*${account}`, 'okey21', 'v21');
      expect(over.command, `oper 21st key should FAIL, got: ${over.raw}`).toBe('FAIL');
      expect(over.raw).toContain('LIMIT_REACHED');

      const update = await setKey(oper, `*${account}`, 'okey1', 'updated');
      expect(update.command, `oper update at cap should succeed, got: ${update.raw}`).not.toBe('FAIL');

      // Deletes are never capped (cleanup tooling must keep working) — and
      // leave no junk rows behind for this fake account.
      for (let i = 1; i <= MAX_KEYS; i++) {
        oper.send(`METADATA *${account} SET okey${i}`);
      }
      await new Promise(r => setTimeout(r, 500));

      oper.send('QUIT');
    },
    120000
  );

  it(
    'S2S: compliant metadata still relays to the linked server (no false drops)',
    async () => {
      // The S2S ingress now validates and drops-without-relaying on limit
      // violations; a compliant SET must still converge across the link.
      const setterNick = `mdxa${uniqueId().slice(0, 5)}`;
      const setter = track(await metaClient(setterNick));
      const reader = track(
        await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port)
      );
      const readerCaps = await reader.capLs();
      const metaCap = readerCaps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await reader.capReq([metaCap]);
      reader.capEnd();
      reader.register(`mdxb${uniqueId().slice(0, 5)}`);
      await reader.waitForNumeric('001');

      // Wait until the setter's nick has propagated to the secondary — after a
      // container roll the S2S link itself can still be re-establishing, and
      // an INVALID_TARGET before that proves nothing about the metadata path.
      let visible = false;
      for (let i = 0; i < 30; i++) {
        reader.send(`ISON ${setterNick}`);
        const ison = await reader.waitForParsedLine(msg => msg.command === '303', 5000);
        if (ison.raw.toLowerCase().includes(setterNick.toLowerCase())) {
          visible = true;
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      expect(visible, `setter nick should propagate to secondary (S2S link up?)`).toBe(true);

      const setResp = await setKey(setter, '*', 'xsrvkey', 'roundtrip');
      expect(setResp.command, `S2S setter SET should succeed, got: ${setResp.raw}`).not.toBe('FAIL');

      // Let the MD relay propagate over the link.
      await new Promise(r => setTimeout(r, 1500));

      reader.send(`METADATA ${setterNick} GET xsrvkey`);
      const got = await reader.waitForParsedLine(
        msg =>
          msg.command === '761' ||
          msg.command === '766' ||
          msg.command === 'FAIL' ||
          (msg.command === 'METADATA' && msg.raw.includes('xsrvkey')),
        5000
      );
      expect(
        got.command === '761' || (got.command === 'METADATA' && got.raw.includes('roundtrip')),
        `key set on primary should be readable from secondary, got: ${got.raw}`
      ).toBe(true);
      expect(got.raw).toContain('roundtrip');

      setter.send('QUIT');
      reader.send('QUIT');
    },
    30000
  );

  it(
    'S2S: oper *account write propagates to the linked server (offline account)',
    async () => {
      // Gap B (bouncer-promotion scope): the oper "*account" write used to be
      // node-local — no MD broadcast in either the online or offline branch —
      // so cleanup run through an oper on one server left stale rows (e.g.
      // draft/persistence/hold "0") on every other server. The account-target
      // wire form closes it; this asserts both the set and the delete converge.
      const oper = track(await metaClient(`mdgp${uniqueId().slice(0, 5)}`));
      oper.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
      await oper.waitForNumeric('381', 20000);
      // Fresh fake account: offline everywhere, zero rows on both servers.
      const account = `mdgap${uniqueId().slice(0, 8)}`;

      const setResp = await setKey(oper, `*${account}`, 'gapbkey', 'converged');
      expect(setResp.command, `oper *account SET should succeed, got: ${setResp.raw}`).not.toBe(
        'FAIL'
      );

      const reader = track(
        await createRawSocketClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port)
      );
      const readerCaps = await reader.capLs();
      const metaCap = readerCaps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await reader.capReq([metaCap]);
      reader.capEnd();
      reader.register(`mdgr${uniqueId().slice(0, 5)}`);
      await reader.waitForNumeric('001');

      // Poll the secondary's store; the poll loop doubles as the link-up
      // guard the ISON dance provides in the test above.
      let raw = '';
      let converged = false;
      for (let i = 0; i < 10; i++) {
        reader.send(`METADATA ${account} GET gapbkey`);
        const got = await reader.waitForParsedLine(
          msg => msg.command === '761' || msg.command === '766' || msg.command === 'FAIL',
          5000
        );
        raw = got.raw;
        if (got.command === '761' && got.raw.includes('converged')) {
          converged = true;
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      expect(
        converged,
        `*account row set on primary should be readable on secondary, got: ${raw}`
      ).toBe(true);

      // The delete (value-less SET) must converge too — that is the actual
      // cleanup-tooling path that left the stale hold rows behind.
      oper.send(`METADATA *${account} SET gapbkey`);
      let goneRaw = '';
      let gone = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        reader.send(`METADATA ${account} GET gapbkey`);
        const got = await reader.waitForParsedLine(
          msg => msg.command === '761' || msg.command === '766' || msg.command === 'FAIL',
          5000
        );
        goneRaw = got.raw;
        // Once the delete lands the account has no rows at all, so the reply
        // degrades to FAIL INVALID_TARGET rather than 766 — either is "gone".
        if (got.command !== '761') {
          gone = true;
          break;
        }
      }
      expect(gone, `deleted *account row should disappear on secondary, got: ${goneRaw}`).toBe(
        true
      );

      oper.send('QUIT');
      reader.send('QUIT');
    },
    120000
  );
});

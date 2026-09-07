/**
 * Federated page holding a long (zstd-compressed) local row.
 *
 * Audit 2026-09-06 #1: merge_messages shallow-copied local rows including
 * their raw_content / dyn_content pointers; the replay engine freed the
 * copies, free_fed_request freed the originals -> double free on any
 * federated page whose LOCAL part carried a row over the compression
 * threshold (256 bytes) or a multiline row.  Trigger: the requester's own
 * server is a storage server with a short local page (< limit) and a
 * storage peer advertised -- the ordinary two-server bed.  Before the fix
 * the primary aborted (glibc double-free detection) on the query.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, PRIMARY_SERVER, uniqueChannel, uniqueNick } from '../helpers/index.js';

const CH = ['draft/chathistory', 'batch', 'server-time', 'message-tags', 'echo-message'];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('federated page with a long local row', () => {
  const clients: RawSocketClient[] = [];
  afterEach(() => { for (const c of clients) { try { c.close(); } catch { /* */ } } clients.length = 0; });

  it('survives and returns the long row (no double free through the merge)', async () => {
    const c = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    clients.push(c);
    await c.capLs(); await c.capReq(CH); c.capEnd();
    c.register(uniqueNick('longrow'));
    await c.waitForNumeric('001');
    const chan = uniqueChannel('longrow');
    c.send(`JOIN ${chan}`); await c.waitForJoin(chan);

    // One row well over the 256-byte compression threshold, plus a short one.
    const long = 'L'.repeat(380);
    c.send(`PRIVMSG ${chan} :${long}`);
    c.send(`PRIVMSG ${chan} :short`);
    await sleep(1200);

    // Short local page (2 rows < 50) => federates to the peer => merge.
    const start = c.allLines.length;
    c.send(`CHATHISTORY LATEST ${chan} * 50`);
    await c.waitForLine(/BATCH -/, 8000);
    const lines = c.allLines.slice(start);
    expect(lines.filter(l => l.includes(long)), 'the long row is replayed intact').toHaveLength(1);
    expect(lines.filter(l => / PRIVMSG .*:short$/.test(l)), 'the short row').toHaveLength(1);

    // The server must still be alive afterwards.
    c.send('PING :alive');
    await c.waitForLine(/PONG .*alive/, 5000);
  });
});

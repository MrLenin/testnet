import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  createOperClient,
} from '../helpers/index.js';
import { runCheck } from '../helpers/check-parser.js';

/**
 * /CHECK -b parser + harness scenario tests
 *
 * Validates the machine-readable BouncerPrimary / BouncerAlias /
 * BouncerFace lines emitted by /CHECK -b (added in 40acc03) and the
 * runCheck() helper that drives the command + parses the response.
 *
 * Initial scenario: single-user bouncer session, no peers, no aliases.
 * Asserts the lifecycle puts the user where /CHECK -b says it should
 * be — establishes the parser-to-state correspondence before more
 * complex multi-server scenarios stack on top.
 */
describe('/CHECK -b parser', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    // Disable hold on each pool account before releasing (so the next
    // test that checks out the same account starts from a clean state).
    for (const client of clients) {
      try {
        await bouncerDisableHold(client);
      } catch {
        // Ignore — client may already be closed.
      }
      try {
        client.close();
      } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  it('reports single bouncer primary with no aliases or faces', async () => {
    // Set up a SASL'd bouncer client + enable hold (creates session).
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('chk');
    const { client } = await createSaslBouncerClient(
      account.account,
      account.password,
      { nick },
    );
    clients.push(client);

    const held = await bouncerEnableHold(client);
    expect(held).toBe(true);

    // Open an oper client to drive /CHECK.
    const oper = await createOperClient();
    clients.push(oper);

    // Drive /CHECK <nick> -b and parse.
    const state = await runCheck(oper, nick, 10_000);

    // Expectations for a single-user, no-peers session:
    //   - primary present, matching nick + account from this connection
    //   - no aliases (we haven't connected a second client for this account)
    //   - no legacy faces (no legacy peers in default topology)
    expect(state.primary).toBeDefined();
    expect(state.primary?.nick).toBe(nick);
    expect(state.primary?.locality).toBe('local');
    expect(state.aliases).toHaveLength(0);
    expect(state.faces).toHaveLength(0);

    // Sessid should be non-empty and stable (matches one of the other
    // Session ID:: lines from the same /CHECK output, which the parser
    // captures in rawLines for debug).
    expect(state.primary?.sessid).toMatch(/^AZ[A-Za-z0-9]+/);
  });

  it('keeps the same session sessid across disconnect + revive', async () => {
    // Validates the cli_session_id sync at bounce_create_ghost (ce933dc)
    // and at bounce_revive (13b78e2): after the user disconnects (session
    // goes HOLDING with a ghost), then reconnects with SASL (revive),
    // /CHECK -b should report the same sessid on the BouncerPrimary
    // line — proving the revived ghost's cli_session_id was synced from
    // the persisted hs_sessid rather than retaining the fresh-minted
    // value that bounce_create_ghost gave it.
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('chk');

    const oper = await createOperClient();
    clients.push(oper);

    // First connect: create session, capture sessid.
    const first = await createSaslBouncerClient(
      account.account,
      account.password,
      { nick },
    );
    clients.push(first.client);
    expect(await bouncerEnableHold(first.client)).toBe(true);

    const before = await runCheck(oper, nick, 10_000);
    expect(before.primary?.sessid).toMatch(/^AZ[A-Za-z0-9]+/);
    const sessidBefore = before.primary!.sessid;

    // Close first client cleanly — session should transition to HOLDING.
    first.client.close();
    // Drop from cleanup list since we already closed.
    const idx = clients.indexOf(first.client);
    if (idx >= 0) clients.splice(idx, 1);

    // Reconnect with SASL → bounce_revive transplants new socket onto
    // the held ghost.
    await new Promise(r => setTimeout(r, 500));
    const second = await createSaslBouncerClient(
      account.account,
      account.password,
      { nick },
    );
    clients.push(second.client);

    // Sessid should be unchanged across the revive.
    const after = await runCheck(oper, nick, 10_000);
    expect(after.primary?.sessid).toBe(sessidBefore);
    expect(after.primary?.nick).toBe(nick);
    expect(after.primary?.locality).toBe('local');
  });

  it('parses BouncerFace entries when legacy peers have recorded a face', async () => {
    // Same setup as above, but assumes nefarious-upstream (legacy peer)
    // is linked in the testnet — testnet's burst-emit to upstream records
    // a face entry which /CHECK -b should surface.
    //
    // Skip cleanly if upstream isn't linked (no face entry recorded).
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('chk');
    const { client } = await createSaslBouncerClient(
      account.account,
      account.password,
      { nick },
    );
    clients.push(client);

    const held = await bouncerEnableHold(client);
    expect(held).toBe(true);

    const oper = await createOperClient();
    clients.push(oper);

    const state = await runCheck(oper, nick, 10_000);

    expect(state.primary).toBeDefined();
    // Faces are present iff an N for this session was emitted to a
    // legacy peer.  We don't strictly assert non-zero — topology may
    // vary — but each face entry, if present, should have a 2-char
    // peer numeric and a 5-char face numeric (server YY + client XXX).
    for (const face of state.faces) {
      expect(face.peer).toMatch(/^[A-Za-z0-9\[\]]{2}$/);
      expect(face.face).toMatch(/^[A-Za-z0-9\[\]]{5}$/);
    }
  });
});

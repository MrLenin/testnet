/**
 * IRCv3 draft/account-registration E2E — local Keycloak REGISTER flow.
 *
 * Server side: nefarious/ircd/m_register.c (m_register/m_verify), sasl_auth.c
 * (KC_UNVERIFIED gate for PLAIN + SCRAM-SHA-256), ircd_features.c
 * (FEAT_REGISTER_VERIFY_EMAIL). The old X3 RG/VF/RR P10 relay is gone —
 * REGISTER creates the Keycloak account directly via libkc, deriving both a
 * PBKDF2 credential (SASL PLAIN) and scram_sha256_* attributes (SASL SCRAM)
 * synchronously before the first async hop.
 *
 * Two legs, two servers (ratified 2026-08-05):
 *   - nefarious  (PRIMARY_SERVER)  — FEAT_REGISTER_VERIFY_EMAIL off (C default).
 *     "C-mode" below == "verification off".
 *   - nefarious2 (SECONDARY_SERVER) — FEAT_REGISTER_VERIFY_EMAIL on
 *     (data/ircd2.conf). Requires the "linked" compose profile; the
 *     verification-on suite skips cleanly (not fails) if nefarious2 is
 *     unreachable, mirroring the pattern in bouncer-alias-multi-server.test.ts.
 *
 * Ground truth for the Keycloak/LDAP assertions is Task 0's live probe
 * (.superpowers/sdd/2026-08-05-account-registration/task-0-report.md):
 *   - A REGISTER-created (daemon-born) account gets an LDAP entry via the
 *     writable LDAP federation, but that entry NEVER gets a `userPassword`
 *     attribute — the write-through creates the record, not a working bind.
 *     These accounts are SASL-only; we assert the entry exists and assert
 *     the *absence* of userPassword, and we do not attempt an LDAP bind.
 *   - The unverified-account ROPC error body is exactly
 *     {"error":"invalid_grant","error_description":"Account is not fully
 *     set up"} — classified by kc_classify_grant_error() into KC_UNVERIFIED,
 *     which sasl_auth.c turns into FAIL AUTHENTICATE VERIFICATION_REQUIRED
 *     (never a bare wrong-password 904 with no context).
 *
 * SASL SCRAM-SHA-256 has no existing TS test helper (server-side is a plain
 * RFC 5802 exchange, ircd/sasl_auth.c ~1274-1700) so this file implements a
 * minimal client HMAC-SHA256/PBKDF2 handshake with node:crypto below.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { randomBytes, createHmac, createHash, pbkdf2Sync } from 'node:crypto';
import {
  createClientOnServer,
  RawSocketClient,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  isSecondaryServerAvailable,
  uniqueId,
  getKeycloakAdminToken,
  authenticateSaslPlain,
  sendSaslPayload,
  type ServerConfig,
  type IRCMessage,
} from '../helpers/index.js';

// ---------------------------------------------------------------------------
// Keycloak admin REST — small local helpers targeting the real 'testnet'
// realm. NOTE: tests/src/helpers/keycloak-sync.ts defaults KEYCLOAK_REALM to
// 'irc' (wrong for this bed); every other suite that talks to Keycloak admin
// REST directly (keycloak.test.ts, scripts/cleanup-tests.ts) instead defaults
// to 'testnet', which is what's actually configured
// (scripts/setup-keycloak.sh). Match that convention here rather than the
// stale default in keycloak-sync.ts.
// ---------------------------------------------------------------------------

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? 'testnet';

interface KcUser {
  id: string;
  username: string;
  email?: string;
  emailVerified?: boolean;
  requiredActions?: string[];
  attributes?: Record<string, string[]>;
}

async function kcGetUserByUsername(token: string, username: string): Promise<KcUser | null> {
  const res = await fetch(
    `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Keycloak admin GET users failed: ${res.status} ${await res.text()}`);
  const users: KcUser[] = await res.json();
  return users[0] ?? null;
}

async function kcSetVerification(token: string, userId: string, verified: boolean): Promise<void> {
  const res = await fetch(`${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      emailVerified: verified,
      requiredActions: verified ? [] : ['VERIFY_EMAIL'],
    }),
  });
  if (!res.ok) throw new Error(`Keycloak admin PUT user failed: ${res.status} ${await res.text()}`);
}

/** Poll until a Keycloak user with `username` exists (REGISTER's Keycloak
 * create is normally synchronous with the REGISTER SUCCESS reply, but this
 * gives the admin REST read-path a little slack under load). */
async function waitForKcUser(token: string, username: string, timeoutMs = 10000): Promise<KcUser> {
  const start = Date.now();
  for (;;) {
    const user = await kcGetUserByUsername(token, username);
    if (user) return user;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for Keycloak user ${username}`);
    await new Promise(r => setTimeout(r, 400));
  }
}

// ---------------------------------------------------------------------------
// LDAP write-through observation (Task 0 ground truth) — openldap has no
// host-exposed port, so ldapsearch runs inside the container via docker exec,
// same idiom as the docker-restart bouncer suites (bouncer-oper-restart.test.ts).
// ---------------------------------------------------------------------------

const LDAP_ADMIN_DN = process.env.X3_LDAP_ADMIN_DN ?? 'cn=admin,dc=fractalrealities,dc=net';
const LDAP_ADMIN_PASS = process.env.X3_LDAP_ADMIN_PASS ?? 'adminpassword';
const LDAP_BASE = 'ou=users,dc=fractalrealities,dc=net';

async function waitForLdapEntry(uid: string, timeoutMs = 10000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const out = execSync(
      `docker exec openldap ldapsearch -x -H ldap://localhost -D "${LDAP_ADMIN_DN}" ` +
        `-w "${LDAP_ADMIN_PASS}" -b "${LDAP_BASE}" "(uid=${uid})" "*" "+"`,
      { encoding: 'utf8' }
    );
    if (out.includes(`uid=${uid},${LDAP_BASE}`)) return out;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for LDAP entry uid=${uid}`);
    await new Promise(r => setTimeout(r, 400));
  }
}

// ---------------------------------------------------------------------------
// SCRAM-SHA-256 client (RFC 5802), matched against nefarious's server-side
// implementation in ircd/sasl_auth.c (no channel binding: gs2-header "n,,").
// ---------------------------------------------------------------------------

function hmacSha256(key: Buffer, msg: string): Buffer {
  return createHmac('sha256', key).update(msg).digest();
}
function sha256(buf: Buffer): Buffer {
  return createHash('sha256').update(buf).digest();
}
function xorBuf(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

interface ScramResult {
  success: boolean;
  numeric?: string;
  failMsg?: IRCMessage;
}

/** Numerics that end a SASL exchange (RPL_LOGGEDIN/RPL_SASLSUCCESS or a
 * failure code). Mirrors the set authenticateSaslPlain() waits on. */
const SASL_RESULT_NUMERICS = ['900', '901', '902', '903', '904', '905', '906', '907', '908'];

/**
 * Perform a full SCRAM-SHA-256 login. Resolves whether the account is
 * verified and the exchange completes, or fails partway through — e.g. the
 * server can reject right after client-first (register_verify_email_policy()
 * gate in sasl_scram_creds_cb, before server-first is ever sent), in which
 * case `failMsg` carries the FAIL AUTHENTICATE line so callers can assert on
 * its code/description.
 */
async function scramSha256Login(
  client: RawSocketClient,
  username: string,
  password: string,
  timeout = 15000
): Promise<ScramResult> {
  client.send('AUTHENTICATE SCRAM-SHA-256');
  await client.waitForParsedLine(msg => msg.command === 'AUTHENTICATE' && msg.params[0] === '+', 5000);

  const clientNonce = randomBytes(18).toString('base64');
  const clientFirstBare = `n=${username},r=${clientNonce}`;
  const clientFirstMessage = `n,,${clientFirstBare}`;
  await sendSaslPayload(client, Buffer.from(clientFirstMessage).toString('base64'));

  // Next line is either the server-first challenge (another AUTHENTICATE
  // payload) or an immediate failure (VERIFICATION_REQUIRED gate fires here,
  // before server-first is ever built).
  let failMsg: IRCMessage | undefined;
  const afterFirst = await client.waitForParsedLine(
    msg =>
      (msg.command === 'AUTHENTICATE' && msg.params[0] !== '+') ||
      msg.command === 'FAIL' ||
      SASL_RESULT_NUMERICS.includes(msg.command),
    timeout
  );
  if (afterFirst.command === 'FAIL') failMsg = afterFirst;
  if (afterFirst.command !== 'AUTHENTICATE') {
    if (afterFirst.command === 'FAIL') {
      // A FAIL AUTHENTICATE line precedes the terminal 904 -- collect that too.
      const term = await client.waitForParsedLine(msg => SASL_RESULT_NUMERICS.includes(msg.command), timeout);
      return { success: false, numeric: term.command, failMsg };
    }
    return { success: afterFirst.command === '900' || afterFirst.command === '903', numeric: afterFirst.command };
  }

  const serverFirst = Buffer.from(afterFirst.params[0], 'base64').toString('utf8');
  const rMatch = /r=([^,]+)/.exec(serverFirst);
  const sMatch = /s=([^,]+)/.exec(serverFirst);
  const iMatch = /i=(\d+)/.exec(serverFirst);
  if (!rMatch || !sMatch || !iMatch) {
    throw new Error(`Malformed SCRAM server-first message: ${serverFirst}`);
  }
  const combinedNonce = rMatch[1];
  const salt = Buffer.from(sMatch[1], 'base64');
  const iterations = parseInt(iMatch[1], 10);

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = hmacSha256(saltedPassword, 'Client Key');
  const storedKey = sha256(clientKey);
  const clientFinalWithoutProof = `c=biws,r=${combinedNonce}`;
  const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
  const clientSignature = hmacSha256(storedKey, authMessage);
  const clientProof = xorBuf(clientKey, clientSignature);
  const clientFinalMessage = `${clientFinalWithoutProof},p=${clientProof.toString('base64')}`;
  await sendSaslPayload(client, Buffer.from(clientFinalMessage).toString('base64'));

  const afterFinal = await client.waitForParsedLine(
    msg =>
      (msg.command === 'AUTHENTICATE' && msg.params[0] !== '+') || SASL_RESULT_NUMERICS.includes(msg.command),
    timeout
  );
  if (afterFinal.command !== 'AUTHENTICATE') {
    return { success: false, numeric: afterFinal.command };
  }
  // afterFinal carries the server-final "v=<ServerSignature>" -- the server
  // requires an explicit client ack before completing login
  // (sasl_scram_complete() in sasl_auth.c, gated on SASL_STATE_SCRAM_VERIFY).
  client.send('AUTHENTICATE +');
  const result = await client.waitForParsedLine(msg => SASL_RESULT_NUMERICS.includes(msg.command), timeout);
  return { success: result.command === '900' || result.command === '903', numeric: result.command };
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

/** Compact unique account name -- ACCOUNTLEN is 15 (ircd_defs.h), so keep
 * well under that (uniqueId() alone is 8 hex chars). */
function uniqueAccount(prefix: string): string {
  return `${prefix}${uniqueId()}`.slice(0, 15);
}

const PASSWORD = 'hunter22xyz';

/** Connect and negotiate `caps` without ending CAP negotiation -- the
 * "before-connect" REGISTER shape: REGISTER is sent pre-registration. */
async function connectPreReg(server: ServerConfig, caps: string[]): Promise<RawSocketClient> {
  const client = await createClientOnServer(server);
  await client.capLs();
  if (caps.length > 0) await client.capReq(caps);
  return client;
}

async function quitAndClose(client: RawSocketClient): Promise<void> {
  try {
    client.send('QUIT');
  } catch {
    // ignore
  }
  client.close();
}

// =============================================================================
// C-mode (verification OFF) -- against PRIMARY_SERVER (nefarious)
// =============================================================================

describe('IRCv3 draft/account-registration (verification off — nefarious)', () => {
  it('advertises min-password-length=5 and NOT email-required in the CAP value', async () => {
    const client = await createClientOnServer(PRIMARY_SERVER);
    try {
      const caps = await client.capLs();
      const value = caps.get('draft/account-registration');
      expect(value, 'draft/account-registration should be advertised').toBeTruthy();
      expect(value).toContain('min-password-length=5');
      expect(value).toContain('max-password-length=300');
      expect(value).toContain('before-connect');
      expect(value).toContain('custom-account-name');
      expect(value).not.toContain('email-required');
    } finally {
      client.close();
    }
  });

  it('registers an account end-to-end: Keycloak + LDAP state, SASL PLAIN + SCRAM both work', async () => {
    const acct = uniqueAccount('regtest');
    const client = await connectPreReg(PRIMARY_SERVER, ['draft/account-registration']);
    try {
      client.send(`REGISTER ${acct} reg-${acct}@test.invalid ${PASSWORD}`);
      const reply = await client.waitForParsedLine(
        msg => msg.command === 'REGISTER' && msg.params[0] === 'SUCCESS',
        15000
      );
      expect(reply.params[1]).toBe(acct);

      // Keycloak state: user exists, scram_sha256_* attributes seeded.
      const token = await getKeycloakAdminToken();
      const user = await waitForKcUser(token, acct);
      expect(user).toBeTruthy();
      for (const key of [
        'scram_sha256_salt',
        'scram_sha256_iterations',
        'scram_sha256_stored_key',
        'scram_sha256_server_key',
      ]) {
        expect(user.attributes?.[key]?.[0], `Keycloak attribute ${key}`).toBeTruthy();
      }

      // LDAP write-through: entry exists (writable federation), but NO
      // userPassword -- daemon-born accounts are SASL-only (Task 0 ground
      // truth). Assert absence, not a bind (the bind is confirmed dead).
      const ldif = await waitForLdapEntry(acct);
      expect(ldif).toContain(`uid=${acct},${LDAP_BASE}`);
      expect(ldif).not.toMatch(/^userPassword/m);

      // Fresh connections: both SASL PLAIN and SASL SCRAM-SHA-256 log in.
      const plainClient = await connectPreReg(PRIMARY_SERVER, ['sasl']);
      try {
        const result = await authenticateSaslPlain(plainClient, acct, PASSWORD);
        expect(result.success, `SASL PLAIN for ${acct}: ${result.error}`).toBe(true);
      } finally {
        await quitAndClose(plainClient);
      }

      const scramClient = await connectPreReg(PRIMARY_SERVER, ['sasl']);
      try {
        const result = await scramSha256Login(scramClient, acct, PASSWORD);
        expect(result.success, `SASL SCRAM-SHA-256 for ${acct}: numeric ${result.numeric}`).toBe(true);
      } finally {
        await quitAndClose(scramClient);
      }
    } finally {
      await quitAndClose(client);
    }
  });

  it('rejects a duplicate account name with ACCOUNT_EXISTS', async () => {
    const acct = uniqueAccount('duptest');
    const client1 = await connectPreReg(PRIMARY_SERVER, ['draft/account-registration']);
    const client2 = await connectPreReg(PRIMARY_SERVER, ['draft/account-registration']);
    try {
      client1.send(`REGISTER ${acct} * ${PASSWORD}`);
      await client1.waitForParsedLine(msg => msg.command === 'REGISTER' && msg.params[0] === 'SUCCESS', 15000);

      client2.send(`REGISTER ${acct} * differentpw123`);
      const fail = await client2.waitForFail('REGISTER', 'ACCOUNT_EXISTS', 15000);
      expect(fail.params[1]).toBe('ACCOUNT_EXISTS');
      expect(fail.params[2]).toBe(acct);
    } finally {
      await quitAndClose(client1);
      await quitAndClose(client2);
    }
  });

  it('rejects an over-length account name with BAD_ACCOUNT_NAME', async () => {
    const client = await connectPreReg(PRIMARY_SERVER, ['draft/account-registration']);
    try {
      const longAccount = 'a'.repeat(50);
      client.send(`REGISTER ${longAccount} * ${PASSWORD}`);
      const fail = await client.waitForFail('REGISTER', 'BAD_ACCOUNT_NAME', 5000);
      expect(fail.params[1]).toBe('BAD_ACCOUNT_NAME');
    } finally {
      await quitAndClose(client);
    }
  });

  it('rejects a too-short password with WEAK_PASSWORD', async () => {
    const acct = uniqueAccount('wpw');
    const client = await connectPreReg(PRIMARY_SERVER, ['draft/account-registration']);
    try {
      client.send(`REGISTER ${acct} * ab`);
      const fail = await client.waitForFail('REGISTER', 'WEAK_PASSWORD', 5000);
      expect(fail.params[1]).toBe('WEAK_PASSWORD');
    } finally {
      await quitAndClose(client);
    }
  });

  it('VERIFY always declines with INVALID_CODE (verification completes via emailed link, not IRC)', async () => {
    const client = await connectPreReg(PRIMARY_SERVER, ['draft/account-registration']);
    try {
      client.send(`VERIFY someaccount SOMECODE`);
      const fail = await client.waitForFail('VERIFY', 'INVALID_CODE', 5000);
      expect(fail.params[1]).toBe('INVALID_CODE');
    } finally {
      await quitAndClose(client);
    }
  });

  it('guards against a pipelined second REGISTER on the same connection', async () => {
    const acct1 = uniqueAccount('pipe1');
    const acct2 = uniqueAccount('pipe2');
    const client = await connectPreReg(PRIMARY_SERVER, ['draft/account-registration']);
    try {
      // Two REGISTERs back-to-back before the first resolves: cli_regcookie()
      // is the one-in-flight guard (m_register.c). The second must be
      // rejected synchronously with TEMPORARILY_UNAVAILABLE, not queued.
      client.send(`REGISTER ${acct1} * ${PASSWORD}`);
      client.send(`REGISTER ${acct2} * ${PASSWORD}`);

      const fail = await client.waitForFail('REGISTER', 'TEMPORARILY_UNAVAILABLE', 15000);
      expect(fail.params[2]).toBe(acct2);
      expect(fail.trailing?.toLowerCase()).toContain('already in progress');

      // Let the first REGISTER resolve too, so the guard clears cleanly
      // before QUIT (reg_ctx_free() releases cli_regcookie() on every path).
      await client.waitForParsedLine(
        msg => msg.command === 'REGISTER' && msg.params[0] === 'SUCCESS' && msg.params[1] === acct1,
        15000
      );
    } finally {
      await quitAndClose(client);
    }
  });

  it('pre-registration REGISTER: the connection carries the account once NICK/USER complete', async () => {
    const acct = uniqueAccount('prereg');
    const nick = uniqueAccount('prn');
    const client = await connectPreReg(PRIMARY_SERVER, ['draft/account-registration']);
    try {
      // REGISTER before CAP END / NICK / USER -- the "before-connect" shape.
      client.send(`REGISTER ${acct} * ${PASSWORD}`);
      const reply = await client.waitForParsedLine(
        msg => msg.command === 'REGISTER' && msg.params[0] === 'SUCCESS',
        15000
      );
      expect(reply.params[1]).toBe(acct);

      // Now finish connection registration. register_complete_success()
      // (m_register.c) parked the account in cli_saslaccount(); it's applied
      // to cli_user()->account by auth_complete_sasl() once NICK/USER land.
      client.capEnd();
      client.register(nick);
      await client.waitForNumeric('001', 15000);

      // No 900/RPL_LOGGEDIN is sent for this path (that numeric is specific
      // to the AUTHENTICATE flow) -- verify the account stuck via a
      // self-WHOIS, which reports it through RPL_WHOISACCOUNT (330).
      client.send(`WHOIS ${nick}`);
      const whoisAccount = await client.waitForParsedLine(
        msg => msg.command === '330' && msg.params[1]?.toLowerCase() === nick.toLowerCase(),
        5000
      );
      expect(whoisAccount.params[2]).toBe(acct);
    } finally {
      await quitAndClose(client);
    }
  });
});

// =============================================================================
// Verification ON -- against SECONDARY_SERVER (nefarious2, FEAT_REGISTER_VERIFY_EMAIL)
// =============================================================================

describe('IRCv3 draft/account-registration (verification on — nefarious2)', () => {
  let secondaryReachable = false;

  const warnUnreachable = () =>
    console.warn(
      `Skipping: nefarious2 (${SECONDARY_SERVER.host}:${SECONDARY_SERVER.port}) not reachable. ` +
        'Run scripts/dc.sh -l up -d, or set IRC_HOST2/IRC_PORT2.'
    );

  beforeAll(async () => {
    secondaryReachable = await isSecondaryServerAvailable();
    if (!secondaryReachable) warnUnreachable();
  });

  it('advertises email-required alongside min-password-length=5 in the CAP value', async () => {
    if (!secondaryReachable) return warnUnreachable();
    const client = await createClientOnServer(SECONDARY_SERVER);
    try {
      const caps = await client.capLs();
      const value = caps.get('draft/account-registration');
      expect(value, 'draft/account-registration should be advertised').toBeTruthy();
      expect(value).toContain('email-required');
      expect(value).toContain('min-password-length=5');
    } finally {
      client.close();
    }
  });

  it('rejects REGISTER with email "*" (no address) with INVALID_EMAIL', async () => {
    if (!secondaryReachable) return warnUnreachable();
    const acct = uniqueAccount('noemail');
    const client = await connectPreReg(SECONDARY_SERVER, ['draft/account-registration']);
    try {
      client.send(`REGISTER ${acct} * ${PASSWORD}`);
      const fail = await client.waitForFail('REGISTER', 'INVALID_EMAIL', 5000);
      expect(fail.params[1]).toBe('INVALID_EMAIL');
    } finally {
      await quitAndClose(client);
    }
  });

  it(
    'REGISTER with email creates an unverified account (VERIFICATION_REQUIRED); ' +
      'send-verify-email failing against the mailer-less realm is non-fatal',
    async () => {
      if (!secondaryReachable) return warnUnreachable();
      const acct = uniqueAccount('regv');
      const client = await connectPreReg(SECONDARY_SERVER, ['draft/account-registration']);
      try {
        client.send(`REGISTER ${acct} ${acct}@test.invalid ${PASSWORD}`);
        // reg_email_cb() (m_register.c) always replies REGISTER
        // VERIFICATION_REQUIRED here, whether or not the send-verify-email
        // Keycloak call itself succeeded (this realm has no mailer
        // configured, so it will not) -- that non-fatality is exactly what
        // this assertion proves.
        const reply = await client.waitForParsedLine(
          msg => msg.command === 'REGISTER' && msg.params[0] === 'VERIFICATION_REQUIRED',
          15000
        );
        expect(reply.params[1]).toBe(acct);

        const token = await getKeycloakAdminToken();
        const user = await waitForKcUser(token, acct);
        expect(user.emailVerified).toBe(false);
        expect(user.requiredActions).toContain('VERIFY_EMAIL');
      } finally {
        await quitAndClose(client);
      }
    }
  );

  it('gates SASL login behind verification, then unblocks it once flipped via admin REST', async () => {
    if (!secondaryReachable) return warnUnreachable();
    const acct = uniqueAccount('gate');
    const regClient = await connectPreReg(SECONDARY_SERVER, ['draft/account-registration']);
    try {
      regClient.send(`REGISTER ${acct} ${acct}@test.invalid ${PASSWORD}`);
      await regClient.waitForParsedLine(
        msg => msg.command === 'REGISTER' && msg.params[0] === 'VERIFICATION_REQUIRED',
        15000
      );
    } finally {
      await quitAndClose(regClient);
    }

    const token = await getKeycloakAdminToken();
    const user = await waitForKcUser(token, acct);

    // Unverified: SASL PLAIN must fail with the verification-specific
    // message (KC_UNVERIFIED classification), never a bare wrong-password.
    const plainClient1 = await connectPreReg(SECONDARY_SERVER, ['sasl']);
    try {
      plainClient1.send('AUTHENTICATE PLAIN');
      await plainClient1.waitForParsedLine(
        msg => msg.command === 'AUTHENTICATE' && msg.params[0] === '+',
        5000
      );
      const payload = Buffer.from(`${acct}\0${acct}\0${PASSWORD}`).toString('base64');
      await sendSaslPayload(plainClient1, payload);
      const failLine = await plainClient1.waitForFail('AUTHENTICATE', 'VERIFICATION_REQUIRED', 15000);
      expect(failLine.trailing?.toLowerCase()).toContain('not verified');
      expect(failLine.trailing?.toLowerCase()).not.toMatch(/wrong password|invalid credentials/);
      await plainClient1.waitForNumeric('904', 5000);
    } finally {
      await quitAndClose(plainClient1);
    }

    // Flip verification via admin REST -- what clicking the emailed link does.
    await kcSetVerification(token, user.id, true);

    // Now both PLAIN and SCRAM succeed.
    const plainClient2 = await connectPreReg(SECONDARY_SERVER, ['sasl']);
    try {
      const result = await authenticateSaslPlain(plainClient2, acct, PASSWORD);
      expect(result.success, `SASL PLAIN post-verification for ${acct}: ${result.error}`).toBe(true);
    } finally {
      await quitAndClose(plainClient2);
    }

    const scramClient = await connectPreReg(SECONDARY_SERVER, ['sasl']);
    try {
      const result = await scramSha256Login(scramClient, acct, PASSWORD);
      expect(result.success, `SASL SCRAM-SHA-256 post-verification for ${acct}: numeric ${result.numeric}`).toBe(
        true
      );
    } finally {
      await quitAndClose(scramClient);
    }
  });
});

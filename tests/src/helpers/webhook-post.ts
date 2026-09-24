/**
 * Drive the ircd's Keycloak webhook listener from a test.
 *
 * The listener accepts a Keycloak-shaped event posted to the container
 * with the ircd's own secret (both read from the server's conf).  A
 * synthetic event carrying a root-level `username` reaches the user-event
 * branch without touching Keycloak, so a pool account can be "disabled"
 * or "deleted" for the ircd's purposes and still log in afterwards.
 */
import * as fs from 'node:fs';
import { createHmac } from 'node:crypto';
import { run } from './bed-control';
import type { RawSocketClient } from './index.js';

export type WebhookTarget = 'nefarious' | 'nefarious2';

const CONF: Record<WebhookTarget, string> = {
  nefarious: '../data/ircd.conf',
  nefarious2: '../data/ircd2.conf',
};

function containerIp(name: string): string {
  return run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name]).trim();
}

function webhookEndpoint(target: WebhookTarget): { port: string; secret: string } {
  const conf = fs.readFileSync(CONF[target], 'utf8');
  const port = /"WEBHOOK_PORT"\s*=\s*"(\d+)"/.exec(conf)?.[1];
  const secret = /"WEBHOOK_SECRET"\s*=\s*"([^"]+)"/.exec(conf)?.[1];
  if (!port || !secret) throw new Error(`WEBHOOK_PORT or WEBHOOK_SECRET not in ${CONF[target]}`);
  return { port, secret };
}

/** The SPI's signature header: HMAC-SHA256 over "<t>.<body>" with the shared secret. */
export function signWebhook(secret: string, t: number, body: string): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/**
 * POST a Keycloak-shaped webhook event to an ircd, signed the way the SPI
 * signs it; resolves to the HTTP status.  `opts` bends the signature for the
 * transport tests: another timestamp, another secret, or no signature at all.
 * The plain secret header is sent as well, as the SPI still does.
 */
export async function postWebhook(body: unknown, target: WebhookTarget = 'nefarious',
                                  opts: { t?: number; secret?: string; unsigned?: boolean } = {}): Promise<number> {
  const { port, secret } = webhookEndpoint(target);
  const payload = JSON.stringify(body);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret };
  if (!opts.unsigned) headers['X-Webhook-Signature'] = signWebhook(opts.secret ?? secret, t, payload);
  const res = await fetch(`http://${containerIp(target)}:${port}/keycloak-webhook`, { method: 'POST', headers, body: payload });
  return res.status;
}

/** The USER/UPDATE event the SPI sends when an account is disabled. */
export function accountDisabledEvent(account: string): Record<string, unknown> {
  return {
    id: `test-disable-${Date.now()}`,
    time: Date.now(),
    realmId: 'testnet',
    realmName: 'testnet',
    resourceType: 'USER',
    operationType: 'UPDATE',
    username: account,
    representation: JSON.stringify({ enabled: false }),
  };
}

/** The USER/DELETE event the SPI sends when an account is removed. */
export function accountDeletedEvent(account: string): Record<string, unknown> {
  return {
    id: `test-delete-${Date.now()}`,
    time: Date.now(),
    realmId: 'testnet',
    realmName: 'testnet',
    resourceType: 'USER',
    operationType: 'DELETE',
    username: account,
  };
}

/**
 * The account oper CHECK shows for one member of a channel.  `marker` is
 * the status character before the nick: '~' alias, '@' op, '+' voice.  An
 * alias row always shows '~' whatever its channel status, so a voiced
 * primary and its alias are told apart by '+' against '~'.
 * RPL_CHANUSER (287): ": <oplvl> <status><nick> (<user>@<host>)   (<info>) <account>"
 */
export async function checkMemberAccount(op: RawSocketClient, channel: string, marker: string, nick: string): Promise<string> {
  op.clearRawBuffer();
  op.send(`CHECK ${channel}`);
  const escaped = marker.replace(/[~@+%<!]/g, (c) => `\\${c}`);
  const row = await op.waitForLine(new RegExp(` 287 \\S+ :.*${escaped}${nick} \\(`), 8000);
  const m = /\)\s+\(.*\) ?(\S*)\s*$/.exec(row);
  return m ? m[1] : '';
}

/** Whether WHOIS finds the nick (311) rather than ERR_NOSUCHNICK (401). */
export async function nickPresent(client: RawSocketClient, nick: string): Promise<boolean> {
  client.clearRawBuffer();
  client.send(`WHOIS ${nick}`);
  const line = await client.waitForLine(new RegExp(` (311|401) \\S+ ${nick} `), 8000);
  return / 311 /.test(line);
}

/**
 * The account WHOIS reports for the nick (330), or '' when it has none.
 * Reads the whole reply: it waits for the end of this WHOIS (318, or 401)
 * and then looks for the 330 among the lines that arrived after the
 * request, so a late line from an earlier reply cannot be mistaken for
 * "no account".
 */
/**
 * The "Without realmName" count that `STATS webhook` reports to an oper: payloads the
 * listener accepted although they named no realm (a pre-signing SPI).  A real Keycloak
 * event leaves it unchanged; a synthetic one without `realmName` raises it by one.
 */
export async function withoutRealmCount(op: RawSocketClient): Promise<number> {
  op.clearRawBuffer();
  op.send('STATS webhook');
  const line = await op.waitForLine(/Without realmName: \d+/, 8000);
  return parseInt(/Without realmName: (\d+)/.exec(line)![1], 10);
}

export async function whoisAccount(client: RawSocketClient, nick: string): Promise<string> {
  const lines = (client as unknown as { lines: { raw: string }[] }).lines;
  client.clearRawBuffer();                  // an earlier reply's unconsumed 318 must not end this wait
  const start = lines.length;
  client.send(`WHOIS ${nick}`);
  await client.waitForLine(new RegExp(` (318|401) \\S+ ${nick} `), 8000);
  const acct = new RegExp(` 330 \\S+ ${nick} (\\S+) `);
  for (let i = start; i < lines.length; i++) {
    const m = acct.exec(lines[i].raw);
    if (m) return m[1];
  }
  return '';
}

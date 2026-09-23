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

/** POST a Keycloak-shaped webhook event to an ircd; resolves to the HTTP status. */
export async function postWebhook(body: unknown, target: WebhookTarget = 'nefarious'): Promise<number> {
  const { port, secret } = webhookEndpoint(target);
  const res = await fetch(`http://${containerIp(target)}:${port}/keycloak-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
    body: JSON.stringify(body),
  });
  return res.status;
}

/** The USER/UPDATE event the SPI sends when an account is disabled. */
export function accountDisabledEvent(account: string): Record<string, unknown> {
  return {
    id: `test-disable-${Date.now()}`,
    time: Date.now(),
    realmId: 'testnet',
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
export async function whoisAccount(client: RawSocketClient, nick: string): Promise<string> {
  const lines = (client as unknown as { lines: { raw: string }[] }).lines;
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

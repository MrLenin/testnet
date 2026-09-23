/**
 * Controlling bed containers from a test. Every call runs a program with an
 * argument array -- no shell, so nothing is ever interpolated into a command.
 *
 * Tests that use these are disruptive by nature (stopping OpenLDAP takes
 * Keycloak federation and every SASL login down with it; restarting x3 drops
 * services). Gate them behind an explicit environment variable, guard any
 * beforeAll that touches containers, and never run them alongside anything
 * else: global setup and teardown are not safe to run concurrently.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function isRunning(container: string): boolean {
  return run('docker', ['inspect', '--format', '{{.State.Running}}', container]).trim() === 'true';
}

/**
 * Make X3 write its databases now, and wait until `handle` is on disk.
 *
 * Call it before restarting X3 with state only in memory: `docker restart`
 * and `docker stop` give X3 10 s, it spends them squitting, and SIGKILL (137)
 * lands before any write -- everything since the last periodic save is lost.
 * SIGQUIT is X3's write-databases signal; the handler only sets a flag and
 * the write happens when the main loop next comes round (observed ~23 s later
 * on a quiet bed).  `handle` should be one this test created, so its presence
 * proves the write happened.
 */
export async function flushX3Saxdb(handle: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x3db-'));
  const copy = path.join(dir, 'x3.db');
  try {
    run('docker', ['kill', '-s', 'QUIT', 'x3']);
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      run('docker', ['cp', 'x3:/x3/data/x3.db', copy]);
      if (fs.readFileSync(copy, 'utf8').includes(`"${handle}"`)) return;
    }
    throw new Error(`X3 never wrote "${handle}" to saxdb after SIGQUIT`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // x3.db holds password hashes
  }
}

/** Wait for a container with a healthcheck to report healthy. */
export function waitHealthy(container: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = run('docker', ['inspect', '--format', '{{.State.Health.Status}}', container]).trim();
    if (state === 'healthy') return;
    run('sleep', ['2']);
  }
  throw new Error(`${container} did not become healthy within ${timeoutMs}ms`);
}

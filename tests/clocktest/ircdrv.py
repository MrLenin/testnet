#!/usr/bin/env python3
"""Throwaway IRC driver for the CRDT clocktest live scenarios.

Lives in /tmp/crdt4c (NOT committed — diagnostic tooling). Minimal synchronous
socket client: register, oper (plaintext oper/shmoo), /CRDT status|clockstep,
TIME probe, docker-log grep helpers, mesh digest convergence check.
"""
import re
import socket
import subprocess
import time

NODES = {
    'nef3': ('nefarious3', 6669),
    'nef4': ('nefarious4', 6670),
    'nef5': ('nefarious5', 6672),
    'nef6': ('nefarious6', 6673),
    'nef7': ('nefarious7', 6674),
}


class Irc:
    def __init__(self, node, nick):
        self.node, self.nick = node, nick
        self.container, self.port = NODES[node]
        self.buf = b''
        self.sock = None

    # -- transport ---------------------------------------------------------
    def connect(self, timeout=25):
        self.sock = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        self.sock.settimeout(0.2)
        self.send('NICK ' + self.nick)
        self.send('USER ct 0 * :clocktest driver')

        def reg(p):
            if p['cmd'] == '433':          # nick in use -> mangle and retry
                self.nick += '_'
                self.send('NICK ' + self.nick)
            return p['cmd'] == '001'
        self.wait(reg, timeout)
        return self

    def close(self):
        try:
            self.send('QUIT :done')
            time.sleep(0.2)
            self.sock.close()
        except Exception:
            pass

    def send(self, line):
        self.sock.sendall((line + '\r\n').encode())

    def _pump(self):
        try:
            data = self.sock.recv(65536)
            if data:
                self.buf += data
        except socket.timeout:
            pass
        out = []
        while b'\r\n' in self.buf:
            raw, self.buf = self.buf.split(b'\r\n', 1)
            p = self._parse(raw.decode('utf-8', 'replace'))
            if p['cmd'] == 'PING':
                self.send('PONG :' + (p['trail'] or ''))
            out.append(p)
        return out

    @staticmethod
    def _parse(line):
        rest, tags, src, trail = line, None, None, None
        if rest.startswith('@'):
            try:
                tags, rest = rest[1:].split(' ', 1)
            except ValueError:
                rest = ''
        if rest.startswith(':'):
            try:
                src, rest = rest[1:].split(' ', 1)
            except ValueError:
                rest = ''
        if ' :' in rest:
            rest, trail = rest.split(' :', 1)
        parts = rest.split()
        return {'line': line, 'tags': tags, 'src': src,
                'cmd': parts[0] if parts else '',
                'args': parts[1:], 'trail': trail}

    def wait(self, pred, timeout=10, on_line=None):
        end = time.time() + timeout
        while time.time() < end:
            for p in self._pump():
                if on_line:
                    on_line(p)
                if pred(p):
                    return p
        raise TimeoutError('%s/%s: wait() timed out' % (self.node, self.nick))

    def drain(self, secs=1.0):
        end = time.time() + secs
        out = []
        while time.time() < end:
            out.extend(self._pump())
        return out

    # -- IRC actions -------------------------------------------------------
    def oper(self):
        self.send('OPER oper shmoo')
        self.wait(lambda p: p['cmd'] == '381', 10)
        self.drain(0.3)
        return self

    def cap_req(self, cap):
        """Post-registration CAP REQ; returns True on ACK."""
        self.drain(0.1)
        self.send('CAP REQ :' + cap)
        p = self.wait(lambda p: p['cmd'] == 'CAP' and len(p['args']) >= 2 and
                      p['args'][1] in ('ACK', 'NAK'), 10)
        return p['args'][1] == 'ACK'

    def notices_until(self, rx, timeout=15):
        got, pat = [], re.compile(rx)

        def coll(p):
            if p['cmd'] == 'NOTICE' and p['trail'] is not None:
                got.append(p['trail'])
        self.wait(lambda p: p['cmd'] == 'NOTICE' and p['trail'] and
                  pat.search(p['trail']), timeout, on_line=coll)
        return got

    def crdt_status(self):
        self.drain(0.1)
        self.send('CRDT status')
        lines = self.notices_until(r'End of /CRDT status')
        txt = '\n'.join(lines)

        def g(rx):
            m = re.search(rx, txt)
            return m.group(1) if m else None
        return {'digest': g(r'(?<!m)digest=([0-9a-f]+)'),
                'mdigest': g(r'mdigest=([0-9a-f]+)'),
                'oplog': g(r'oplog=(\d+)'),
                'mismatch': g(r'(\d+) mismatch'),
                'lines': lines}

    def clockstep(self, secs):
        self.drain(0.1)
        self.send('CRDT clockstep %+d' % secs)
        p = self.wait(lambda p: p['cmd'] == 'NOTICE' and p['trail'] and
                      'clockstep' in p['trail'], 10)
        return p['trail']

    def time_ts(self):
        """391 <me> <server> <TStime> <TSoffset> :<date> -> TStime (int)."""
        self.drain(0.1)
        self.send('TIME')
        p = self.wait(lambda p: p['cmd'] == '391', 10)
        return int(p['args'][2])


# -- bed helpers -----------------------------------------------------------
def open_opers(nodes, prefix='ctO'):
    ops = {}
    for i, n in enumerate(nodes):
        ops[n] = Irc(n, '%s%d' % (prefix, i)).connect().oper()
    return ops


def close_all(clients):
    vals = clients.values() if isinstance(clients, dict) else clients
    for c in vals:
        c.close()


def mesh_digests(opers):
    return {n: c.crdt_status() for n, c in opers.items()}


def report_digests(d):
    for n, s in sorted(d.items()):
        print('  %s: digest=%s mdigest=%s oplog=%s mismatch=%s'
              % (n, s['digest'], s['mdigest'], s['oplog'], s['mismatch']))
    ds = set(s['digest'] for s in d.values())
    ms = set(s['mdigest'] for s in d.values())
    return len(ds) == 1 and len(ms) == 1 and None not in ds and None not in ms


def wait_converged(opers, timeout=90, poll=4):
    """Poll until the MATERIALIZED digest (mdigest) is identical everywhere.
    mdigest is the GC-invariant convergence metric; the raw doc digest flaps
    transiently during per-node GC / expiry-tombstone waves by design.
    Returns (converged, seconds_taken, last_snap)."""
    t0 = time.time()
    while True:
        snap = mesh_digests(opers)
        ms = set(s['mdigest'] for s in snap.values())
        if len(ms) == 1 and None not in ms:
            return True, time.time() - t0, snap
        if time.time() - t0 > timeout:
            return False, time.time() - t0, snap
        end = time.time() + poll
        while time.time() < end:
            for c in opers.values():
                c.drain(0.05)
            time.sleep(0.5)


def dlog(container, since, pattern):
    r = subprocess.run(['docker', 'logs', '--since', since, container],
                       capture_output=True, text=True)
    return [l for l in (r.stdout + r.stderr).splitlines()
            if re.search(pattern, l)]


def restart_counts():
    out = {}
    for n, (c, _) in NODES.items():
        r = subprocess.run(['docker', 'inspect', '-f', '{{.RestartCount}}', c],
                           capture_output=True, text=True)
        out[n] = r.stdout.strip()
    return out

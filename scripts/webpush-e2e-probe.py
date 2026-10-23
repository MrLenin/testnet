import socket, time, base64, json, urllib.request, os
HOST='fractalrealities.afternet.org'; PORT=6667
ACCT=os.environ['BT_ACCT']; PASS=os.environ['BT_PASS']
UUID=os.environ['WEBHOOK_SITE_UUID']   # a webhook.site inbox: its id reads it
ENDPOINT=f'https://webhook.site/{UUID}'
KEYS=os.environ['WEBPUSH_KEYS']   # 'p256dh=<b64url>;auth=<b64url>' of a subscription you hold

class C:
    def __init__(s, tag):
        s.tag=tag; s.sock=socket.create_connection((HOST,PORT),timeout=20); s.f=s.sock.makefile('r',encoding='utf-8',errors='replace'); s.nick=None
    def send(s,l): s.sock.sendall((l+'\r\n').encode())
    def until(s, pred, timeout=15):
        end=time.time()+timeout
        while time.time()<end:
            try: line=s.f.readline()
            except socket.timeout: return None
            if not line: return None
            line=line.rstrip('\r\n')
            if line.startswith('PING'): s.send('PONG '+line.split(' ',1)[1]); continue
            if pred(line): return line
        return None
    def close(s):
        try: s.send('QUIT :done'); s.sock.close()
        except: pass

def sasl_login(c, nick):
    c.send('CAP LS 302'); c.send(f'NICK {nick}'); c.send('USER bt 0 * :bt')
    c.until(lambda l: ' CAP ' in l and ' LS ' in l and ' * :' not in l or (' CAP ' in l and ' LS :' in l), 10)
    c.send('CAP REQ :sasl draft/webpush')
    c.until(lambda l: ' ACK ' in l, 10)
    c.send('AUTHENTICATE PLAIN'); c.until(lambda l: l.startswith('AUTHENTICATE +'), 10)
    c.send('AUTHENTICATE '+base64.b64encode(f'{ACCT}\0{ACCT}\0{PASS}'.encode()).decode())
    r=c.until(lambda l: ' 903 ' in l or ' 904 ' in l, 20); print(c.tag,'sasl:', r.split(' ',3)[3] if r else 'TIMEOUT')
    c.send('CAP END')
    w=c.until(lambda l: ' 001 ' in l, 20); c.nick=w.split(' ')[2] if w else None; print(c.tag,'nick:',c.nick)
    v=c.until(lambda l: ' 005 ' in l and 'VAPID=' in l, 10); print(c.tag,'vapid:', [t for t in (v or '').split(' ') if t.startswith('VAPID=')])
    time.sleep(1)

a=C('A'); sasl_login(a, 'bte2e')
a.send(f'WEBPUSH REGISTER {ENDPOINT} {KEYS}')
r=a.until(lambda l: 'WEBPUSH' in l or 'FAIL' in l, 10); print('A register:', r)
held=a.nick
a.close(); print('A quit (should hold as', held, ')'); time.sleep(4)

b=C('B'); b.send('NICK btsndr'); b.send('USER s 0 * :s'); b.until(lambda l: ' 001 ' in l, 20); time.sleep(1)
b.send(f'WHOIS {held}'); w=b.until(lambda l: ' 311 ' in l or ' 401 ' in l, 10); print('B whois held:', (w or 'TIMEOUT')[:120])
b.send(f'PRIVMSG {held} :push probe {int(time.time())}'); time.sleep(2); b.close()

print('polling capture endpoint...')
seen=None
for i in range(12):
    time.sleep(3)
    try:
        d=json.load(urllib.request.urlopen(f'https://webhook.site/token/{UUID}/requests?sorting=newest', timeout=15))
        if d.get('data'):
            seen=d['data'][0]; break
    except Exception as e: print('poll err', e)
if seen:
    h={k.lower():v for k,v in seen.get('headers',{}).items()}
    print('CAPTURED:', seen.get('method'), 'from', seen.get('ip'), 'size', seen.get('size'))
    for k in ('authorization','content-encoding','ttl','content-type','user-agent'):
        val=h.get(k); print(' ',k+':', (val[0] if isinstance(val,list) else val) if val else None)
else:
    print('NO REQUEST captured within ~40s')

c=C('A2'); sasl_login(c, 'bte2e2'); c.send(f'WEBPUSH UNREGISTER {ENDPOINT}')
r=c.until(lambda l: 'WEBPUSH' in l or 'FAIL' in l, 10); print('cleanup unregister:', r); c.close()

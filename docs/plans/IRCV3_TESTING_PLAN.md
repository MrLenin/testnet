# IRCv3 Feature Testing Plan

## Overview

Comprehensive testing plan for all implemented IRCv3 features in Nefarious and X3.

---

## Test Environment

### Docker Compose Setup
```yaml
services:
  nefarious:
    # IRCd with all IRCv3 features
    ports:
      - "6667:6667"   # Plain IRC
      - "4497:4497"   # SSL IRC
      - "8080:8080"   # WebSocket
  x3:
    # Services with LMDB, Keycloak
```

### Test Clients
- **ircdog** - Raw IRC protocol testing
- **weechat** - Full-featured client with CAP support
- **irssi** - Alternative client
- **wscat** - WebSocket testing
- **curl** - API testing (Keycloak)

---

## Feature Test Matrix

| Feature | Component | Test Type | Priority |
|---------|-----------|-----------|----------|
| CAP negotiation | Nefarious | Functional | High |
| SASL auth | Both | Integration | High |
| Metadata | Both | Integration | High |
| Chathistory | Both | Integration | High |
| Read markers | Both | Integration | Medium |
| WebSocket | Nefarious | Functional | High |
| Multiline | Nefarious | Functional | Medium |
| Message redaction | Both | Integration | Medium |
| Presence aggregation | Nefarious | Functional | Medium |
| LMDB storage | Both | Unit | High |
| zstd compression | Both | Unit | Medium |

---

## Test Scripts

### 1. CAP Negotiation Test

**File: `tests/test_cap.sh`**
```bash
#!/bin/bash
# Test CAP negotiation for all supported capabilities

CAPS=(
    "multi-prefix"
    "userhost-in-names"
    "extended-join"
    "away-notify"
    "account-notify"
    "sasl"
    "server-time"
    "echo-message"
    "account-tag"
    "chghost"
    "invite-notify"
    "labeled-response"
    "batch"
    "setname"
    "message-tags"
    "draft/chathistory"
    "draft/read-marker"
    "draft/multiline"
    "draft/metadata-2"
    "draft/message-redaction"
    "draft/event-playback"
    "draft/pre-away"
    "draft/no-implicit-names"
    "draft/channel-rename"
    "draft/account-registration"
    "draft/webpush"
    "draft/extended-isupport"
)

echo "Testing CAP negotiation..."

# Request CAP LS
echo "CAP LS 302" | nc localhost 6667 | grep -E "^:.*CAP.*LS" > /tmp/caps.txt

for cap in "${CAPS[@]}"; do
    if grep -q "$cap" /tmp/caps.txt; then
        echo "[PASS] $cap advertised"
    else
        echo "[FAIL] $cap NOT advertised"
    fi
done
```

### 2. SASL Authentication Test

**File: `tests/test_sasl.sh`**
```bash
#!/bin/bash
# Test SASL PLAIN authentication

ACCOUNT="testuser"
PASSWORD="testpass"

# Create base64 auth string
AUTH=$(echo -ne "\0${ACCOUNT}\0${PASSWORD}" | base64)

{
    echo "CAP LS 302"
    sleep 0.1
    echo "CAP REQ :sasl"
    sleep 0.1
    echo "AUTHENTICATE PLAIN"
    sleep 0.1
    echo "AUTHENTICATE $AUTH"
    sleep 0.1
    echo "CAP END"
    sleep 0.1
    echo "NICK testuser"
    echo "USER testuser 0 * :Test User"
    sleep 1
} | nc localhost 6667 | tee /tmp/sasl.log

if grep -q "903 .* :SASL authentication successful" /tmp/sasl.log; then
    echo "[PASS] SASL authentication"
else
    echo "[FAIL] SASL authentication"
fi
```

### 3. Metadata Test

**File: `tests/test_metadata.sh`**
```bash
#!/bin/bash
# Test metadata set/get operations

{
    # Connect and authenticate
    echo "NICK metauser"
    echo "USER metauser 0 * :Metadata Test"
    sleep 1

    # Request metadata capability
    echo "CAP REQ :draft/metadata-2"
    sleep 0.5
    echo "CAP END"
    sleep 0.5

    # Set metadata
    echo "METADATA * SET avatar :https://example.com/avatar.png"
    sleep 0.5

    # Get metadata
    echo "METADATA * GET avatar"
    sleep 0.5

    # List all metadata
    echo "METADATA * LIST"
    sleep 1

} | nc localhost 6667 | tee /tmp/metadata.log

# Verify
if grep -q "METADATA .* avatar" /tmp/metadata.log; then
    echo "[PASS] Metadata set/get"
else
    echo "[FAIL] Metadata set/get"
fi
```

### 4. Chathistory Test

**File: `tests/test_chathistory.sh`**
```bash
#!/bin/bash
# Test chathistory retrieval

{
    echo "NICK histuser"
    echo "USER histuser 0 * :History Test"
    sleep 1
    echo "CAP REQ :draft/chathistory server-time message-tags batch"
    sleep 0.5
    echo "CAP END"
    sleep 0.5

    # Join channel
    echo "JOIN #test"
    sleep 0.5

    # Send some messages
    echo "PRIVMSG #test :Test message 1"
    echo "PRIVMSG #test :Test message 2"
    echo "PRIVMSG #test :Test message 3"
    sleep 0.5

    # Request history
    echo "CHATHISTORY LATEST #test * 10"
    sleep 1

} | nc localhost 6667 | tee /tmp/chathistory.log

# Verify batch response
if grep -q "BATCH.*chathistory" /tmp/chathistory.log; then
    echo "[PASS] Chathistory retrieval"
else
    echo "[FAIL] Chathistory retrieval"
fi
```

### 5. Read Marker Test

**File: `tests/test_readmarker.sh`**
```bash
#!/bin/bash
# Test read marker sync

{
    echo "NICK readuser"
    echo "USER readuser 0 * :Read Marker Test"
    sleep 1
    echo "CAP REQ :draft/read-marker"
    sleep 0.5
    echo "CAP END"
    sleep 0.5

    echo "JOIN #test"
    sleep 0.5

    # Set read marker
    TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    echo "MARKREAD #test timestamp=$TIMESTAMP"
    sleep 0.5

    # Get read marker
    echo "MARKREAD #test"
    sleep 1

} | nc localhost 6667 | tee /tmp/readmarker.log

if grep -q "MARKREAD.*timestamp=" /tmp/readmarker.log; then
    echo "[PASS] Read marker sync"
else
    echo "[FAIL] Read marker sync"
fi
```

### 6. WebSocket Test

**File: `tests/test_websocket.sh`**
```bash
#!/bin/bash
# Test WebSocket transport

# Requires wscat: npm install -g wscat

echo "Testing WebSocket connection..."

{
    echo "NICK wsuser"
    echo "USER wsuser 0 * :WebSocket Test"
    sleep 1
    echo "QUIT"
} | wscat -c ws://localhost:8080 --subprotocol text.ircv3.net 2>&1 | tee /tmp/websocket.log

if grep -q "001 wsuser :Welcome" /tmp/websocket.log; then
    echo "[PASS] WebSocket transport"
else
    echo "[FAIL] WebSocket transport"
fi
```

### 7. Multiline Test

**File: `tests/test_multiline.sh`**
```bash
#!/bin/bash
# Test multiline message capability

{
    echo "NICK multiuser"
    echo "USER multiuser 0 * :Multiline Test"
    sleep 1
    echo "CAP REQ :draft/multiline batch"
    sleep 0.5
    echo "CAP END"
    sleep 0.5

    echo "JOIN #test"
    sleep 0.5

    # Send multiline message using BATCH
    BATCH_ID="multi123"
    echo "BATCH +$BATCH_ID draft/multiline #test"
    echo "@batch=$BATCH_ID PRIVMSG #test :Line 1"
    echo "@batch=$BATCH_ID PRIVMSG #test :Line 2"
    echo "@batch=$BATCH_ID PRIVMSG #test :Line 3"
    echo "BATCH -$BATCH_ID"
    sleep 1

} | nc localhost 6667 | tee /tmp/multiline.log

if grep -q "BATCH.*multiline" /tmp/multiline.log; then
    echo "[PASS] Multiline messages"
else
    echo "[FAIL] Multiline messages"
fi
```

### 8. Message Redaction Test

**File: `tests/test_redaction.sh`**
```bash
#!/bin/bash
# Test message redaction

{
    echo "NICK redactuser"
    echo "USER redactuser 0 * :Redaction Test"
    sleep 1
    echo "CAP REQ :draft/message-redaction message-tags server-time"
    sleep 0.5
    echo "CAP END"
    sleep 0.5

    echo "JOIN #test"
    sleep 0.5

    # Send message (need to capture msgid from echo)
    echo "PRIVMSG #test :This message will be redacted"
    sleep 0.5

    # Redact by msgid (would need actual msgid)
    echo "REDACT #test msgid123"
    sleep 1

} | nc localhost 6667 | tee /tmp/redaction.log

# Check for REDACT support
if grep -q "draft/message-redaction" /tmp/caps.txt 2>/dev/null; then
    echo "[PASS] Message redaction capability"
else
    echo "[INFO] Message redaction test requires actual msgid"
fi
```

### 9. LMDB Storage Test

**File: `tests/test_lmdb.sh`**
```bash
#!/bin/bash
# Test LMDB persistence

echo "Testing LMDB storage..."

# Set metadata
{
    echo "NICK lmdbuser"
    echo "USER lmdbuser 0 * :LMDB Test"
    sleep 1
    echo "PRIVMSG NickServ :REGISTER password email@test.com"
    sleep 2
    echo "PRIVMSG NickServ :SET METADATA testkey testvalue"
    sleep 1
    echo "QUIT"
} | nc localhost 6667

# Restart X3 (docker compose restart x3)
echo "Restarting X3..."
docker compose restart x3
sleep 5

# Verify persistence
{
    echo "NICK lmdbuser"
    echo "USER lmdbuser 0 * :LMDB Test"
    sleep 1
    echo "PRIVMSG NickServ :IDENTIFY password"
    sleep 1
    echo "PRIVMSG NickServ :GET METADATA testkey"
    sleep 1
} | nc localhost 6667 | tee /tmp/lmdb.log

if grep -q "testvalue" /tmp/lmdb.log; then
    echo "[PASS] LMDB persistence"
else
    echo "[FAIL] LMDB persistence"
fi
```

### 10. Compression Test

**File: `tests/test_compression.sh`**
```bash
#!/bin/bash
# Test zstd compression for large values

LARGE_VALUE=$(head -c 1000 /dev/urandom | base64 | tr -d '\n')

{
    echo "NICK compuser"
    echo "USER compuser 0 * :Compression Test"
    sleep 1
    echo "PRIVMSG NickServ :REGISTER password email@test.com"
    sleep 2
    echo "PRIVMSG NickServ :SET METADATA largekey $LARGE_VALUE"
    sleep 1
    echo "PRIVMSG NickServ :GET METADATA largekey"
    sleep 1
} | nc localhost 6667 | tee /tmp/compression.log

if grep -q "$LARGE_VALUE" /tmp/compression.log; then
    echo "[PASS] Large value storage (compression)"
else
    echo "[FAIL] Large value storage"
fi
```

---

## Integration Test Suite

### Run All Tests

**File: `tests/run_all.sh`**
```bash
#!/bin/bash

TESTS=(
    "test_cap.sh"
    "test_sasl.sh"
    "test_metadata.sh"
    "test_chathistory.sh"
    "test_readmarker.sh"
    "test_websocket.sh"
    "test_multiline.sh"
    "test_redaction.sh"
    "test_lmdb.sh"
    "test_compression.sh"
)

PASS=0
FAIL=0

echo "================================"
echo "IRCv3 Feature Test Suite"
echo "================================"

for test in "${TESTS[@]}"; do
    echo ""
    echo "Running $test..."
    echo "--------------------------------"
    if bash "tests/$test"; then
        ((PASS++))
    else
        ((FAIL++))
    fi
done

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"
```

---

## Python Test Framework

For more robust testing, use pytest:

**File: `tests/test_ircv3.py`**
```python
import pytest
import socket
import time
import base64

class IRCClient:
    def __init__(self, host='localhost', port=6667):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.connect((host, port))
        self.sock.settimeout(5.0)
        self.buffer = ''

    def send(self, msg):
        self.sock.send(f"{msg}\r\n".encode())

    def recv_until(self, pattern, timeout=5):
        end_time = time.time() + timeout
        while time.time() < end_time:
            try:
                data = self.sock.recv(4096).decode()
                self.buffer += data
                if pattern in self.buffer:
                    return self.buffer
            except socket.timeout:
                continue
        return self.buffer

    def close(self):
        self.sock.close()


class TestCAP:
    def test_cap_ls(self):
        client = IRCClient()
        client.send("CAP LS 302")
        response = client.recv_until("CAP * LS")
        assert "multi-prefix" in response
        assert "sasl" in response
        client.close()

    def test_cap_req(self):
        client = IRCClient()
        client.send("CAP LS 302")
        client.recv_until("CAP * LS")
        client.send("CAP REQ :multi-prefix")
        response = client.recv_until("CAP * ACK")
        assert "multi-prefix" in response
        client.close()


class TestSASL:
    def test_sasl_plain(self):
        client = IRCClient()
        client.send("CAP LS 302")
        client.recv_until("CAP * LS")
        client.send("CAP REQ :sasl")
        client.recv_until("CAP * ACK")
        client.send("AUTHENTICATE PLAIN")
        client.recv_until("AUTHENTICATE +")

        # testuser:testpass
        auth = base64.b64encode(b"\0testuser\0testpass").decode()
        client.send(f"AUTHENTICATE {auth}")
        response = client.recv_until("903", timeout=10)
        assert "SASL authentication successful" in response
        client.close()


class TestMetadata:
    @pytest.fixture
    def authed_client(self):
        client = IRCClient()
        client.send("NICK metauser")
        client.send("USER metauser 0 * :Test")
        client.recv_until("001")
        client.send("CAP REQ :draft/metadata-2")
        client.recv_until("ACK")
        yield client
        client.close()

    def test_metadata_set_get(self, authed_client):
        authed_client.send("METADATA * SET testkey :testvalue")
        time.sleep(0.5)
        authed_client.send("METADATA * GET testkey")
        response = authed_client.recv_until("METADATA")
        assert "testvalue" in response


class TestChathistory:
    def test_chathistory_latest(self):
        client = IRCClient()
        client.send("NICK histuser")
        client.send("USER histuser 0 * :Test")
        client.recv_until("001")
        client.send("CAP REQ :draft/chathistory batch server-time")
        client.recv_until("ACK")
        client.send("CAP END")
        client.send("JOIN #test")
        client.recv_until("JOIN")
        client.send("CHATHISTORY LATEST #test * 10")
        response = client.recv_until("BATCH", timeout=10)
        assert "chathistory" in response
        client.close()
```

---

## Continuous Integration

### GitHub Actions Workflow

**File: `.github/workflows/test.yml`**
```yaml
name: IRCv3 Tests

on:
  push:
    branches: [main, ircv3.2-upgrade]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - name: Start services
        run: docker compose up -d

      - name: Wait for services
        run: sleep 30

      - name: Run tests
        run: |
          pip install pytest
          pytest tests/test_ircv3.py -v

      - name: Stop services
        run: docker compose down
```

---

## Test Coverage Goals

| Category | Coverage Target |
|----------|-----------------|
| CAP negotiation | 100% of advertised caps |
| SASL | PLAIN, EXTERNAL |
| Metadata | Set, Get, List, Delete |
| Chathistory | LATEST, BEFORE, AFTER, AROUND |
| Read markers | Set, Get, Sync |
| WebSocket | Connect, Send, Receive |
| Multiline | Batch send/receive |
| LMDB | Persistence across restart |
| Compression | Large value handling |

---

## Test Data

### Sample Accounts
| Account | Password | Purpose |
|---------|----------|---------|
| testuser | testpass | SASL testing |
| metauser | metapass | Metadata testing |
| histuser | histpass | History testing |
| oper | operpass | Operator testing |

### Sample Channels
| Channel | Purpose |
|---------|---------|
| #test | General testing |
| #history | Chathistory testing |
| #metadata | Channel metadata testing |

---

## Reporting

Test results should include:
- Pass/fail status
- Response times
- Error messages
- Protocol traces (optional, for debugging)

Output format:
```
[2024-12-25 10:30:00] TEST: CAP negotiation
[2024-12-25 10:30:00] SEND: CAP LS 302
[2024-12-25 10:30:01] RECV: :server CAP * LS :multi-prefix sasl ...
[2024-12-25 10:30:01] RESULT: PASS
```

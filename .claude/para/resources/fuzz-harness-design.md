# Fuzzing Harness Design for Nefarious IRCd

This document describes fuzzing harness designs for security testing.

## Priority Targets

1. **IRC Client Parser** - `ircd/parse.c:parse_client()`
2. **WebSocket Frame Parser** - `ircd/websocket.c:websocket_decode_frame()`
3. **SASL AUTHENTICATE Handler** - `ircd/m_authenticate.c:m_authenticate()`

## IRC Client Parser Harness

```c
// fuzz_parse_client.c - AFL harness for IRC client parsing
#include "config.h"
#include "client.h"
#include "parse.h"
#include <string.h>
#include <stdlib.h>

// Mock client structure
static struct Client mock_client;

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    char buf[513]; // Max IRC line + null

    if (size > 512) size = 512;
    memcpy(buf, data, size);
    buf[size] = '\0';

    // Initialize mock client
    memset(&mock_client, 0, sizeof(mock_client));
    // Set minimal required fields...

    // Call parser
    parse_client(&mock_client, buf, buf + size);

    return 0;
}
```

## WebSocket Frame Parser Harness

```c
// fuzz_websocket.c - AFL harness for WebSocket frame parsing
#include "config.h"
#include "websocket.h"
#include <string.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    char payload[16385];
    int payload_len, opcode, is_fin;

    websocket_decode_frame(data, size, payload, sizeof(payload),
                          &payload_len, &opcode, &is_fin);

    return 0;
}
```

## Build Instructions

```bash
# Compile with AFL instrumentation
CC=afl-clang-fast CFLAGS="-fsanitize=address,undefined" \
    ./configure --prefix=/tmp/nef-fuzz
make clean && make

# Build harness
afl-clang-fast -fsanitize=address,undefined \
    -I include -I ircd \
    fuzz_parse_client.c ircd/*.o -o fuzz_parse

# Run fuzzer
mkdir -p corpus crashes
echo "NICK test" > corpus/seed1.txt
echo "USER a * * :b" > corpus/seed2.txt
afl-fuzz -i corpus -o crashes ./fuzz_parse
```

## Corpus Seeds

### IRC Protocol Seeds
```
NICK fuzztest\r\n
USER fuzz * * :Fuzzing\r\n
PRIVMSG #channel :test\r\n
MODE #channel +o nick\r\n
AUTHENTICATE PLAIN\r\n
CAP LS 302\r\n
```

### Edge Cases to Test
- Lines > 512 bytes
- Missing CRLF
- Null bytes in middle
- Invalid UTF-8 sequences
- Empty parameters
- Excessive parameters

## Expected Issues to Find

1. Buffer overflows in message parsing
2. Integer overflows in length calculations
3. Null pointer dereferences on malformed input
4. Use-after-free in error paths

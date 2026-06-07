# Lightweight CRDT-engine test container (CRDT-mesh Phase 0).
#
# Compiles ONLY the dependency-light CRDT engine + its CMocka suite, in
# isolation from the full ircd build (no configure, no RocksDB/zstd/libkc).
# Build artifacts stay inside the image — the source tree is never touched.
#
# Build context is the nefarious-crdt submodule:
#   docker build -f tests/crdt/Dockerfile -t crdt-test ./nefarious-crdt
#   docker run --rm crdt-test           # runs the suite (red/green)
# or just: tests/crdt/run.sh
FROM debian:13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev libcmocka-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Only the files the engine + suite need (keeps the layer small and the
# dependency surface explicit).
COPY include/crdt_hlc.h include/crdt_types.h include/crdt_state.h include/crdt_wire.h include/s2s_chunk.h /src/include/
COPY ircd/crdt_hlc.c ircd/crdt_types.c ircd/crdt_state.c ircd/crdt_wire.c ircd/s2s_chunk.c ircd/crdt_sim.c /src/ircd/
COPY ircd/test/crdt_cmocka.c /src/ircd/test/

# Minimal shims so crdt_hlc.c (whose only ircd deps are config.h + ircd_log.h's
# log_write) compiles standalone. The real build links the real test_stub.o /
# ircd objects; this fast loop only needs log_write.
RUN mkdir -p /src/shims && \
    printf '/* test shim config: real ircd config.h pulls in std headers */\n#include <stddef.h>\n#include <stdint.h>\n' > /src/shims/config.h && \
    printf '#ifndef SHIM_IRCD_LOG_H\n#define SHIM_IRCD_LOG_H\nenum LogSys { LS_SYSTEM };\nenum LogLevel { L_WARNING };\nvoid log_write(enum LogSys, enum LogLevel, unsigned int, const char *, ...);\n#endif\n' > /src/shims/ircd_log.h && \
    printf '#include "ircd_log.h"\n#include <stdarg.h>\n#include <stdio.h>\nvoid log_write(enum LogSys s, enum LogLevel l, unsigned int f, const char *fmt, ...){(void)s;(void)l;(void)f; va_list a; va_start(a,fmt); vfprintf(stderr,fmt,a); va_end(a); fputc(10,stderr);}\n' > /src/shims/log_stub.c

# Compile + link the CMocka suite. A missing engine symbol fails HERE (TDD red).
RUN gcc -O0 -g -Wall -Wextra -Wno-unused-parameter \
        -I/src/include -I/src/shims \
        /src/ircd/test/crdt_cmocka.c \
        /src/ircd/crdt_hlc.c /src/ircd/crdt_types.c /src/ircd/crdt_state.c \
        /src/ircd/crdt_wire.c /src/ircd/s2s_chunk.c \
        /src/shims/log_stub.c \
        -lcmocka -o /src/crdt_cmocka

# Standalone tombstone-growth stress harness (scenario D), no cmocka.
RUN gcc -O2 -g -Wall -Wextra -Wno-unused-parameter \
        -I/src/include -I/src/shims \
        /src/ircd/crdt_sim.c \
        /src/ircd/crdt_hlc.c /src/ircd/crdt_types.c /src/ircd/crdt_state.c \
        /src/shims/log_stub.c \
        -o /src/crdt_sim

CMD ["/src/crdt_cmocka"]

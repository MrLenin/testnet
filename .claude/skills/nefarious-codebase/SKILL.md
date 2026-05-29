---
name: nefarious-codebase
description: General Nefarious IRCd C codebase reference — Client vs Connection accessor patterns, ircd_strncpy strlcpy semantics and the truncation audit rule, the libkc/curl_multi event adapter, ircd.conf block-ordering and syntax gotchas, and the Docker build/test workflow. Use when editing IRCd C code, chasing accessor or buffer-truncation bugs, or touching config parsing.
---

# Nefarious Codebase Skill

General reference for working in the Nefarious IRCd C codebase: client/connection accessor patterns, the libkc/curl_multi event adapter, config-file parsing rules, and build/test workflow. For the bouncer subsystem see `bouncer-architecture.md`; for P10 see `p10-protocol.md`.

## Client / Connection Accessor Patterns

Some state lives on the `Client` struct, some on its `Connection`. Getting the indirection wrong compiles but reads garbage.

- `cli_sock_ip(cli)` → `con_sock_ip(cli_connect(cli))` — on the Connection struct
- `cli_ip(cli)` → `cli->cli_ip` — on the Client struct directly
- `cli_listener(cli)` → `con_listener(cli_connect(cli))` — on the Connection struct
- Confs are SLink lists on the Connection; must be detached properly (ref-counted ConfItems). `det_confs_butmask(client, 0)` detaches all confs (declared in `s_conf.h`).
- `release_listener()` decrements the listener ref count (declared in `listener.h`).
- `HasFlag(cli, FLAG_KILLED)` — there is **no** `IsKilled` macro. `IsDead(cli)` checks `FLAG_DEADSOCKET`.

### String copies — `ircd_strncpy` semantics (post-cf09cec4)

`ircd_strncpy(dest, src, n)` now has **BSD strlcpy semantics**: `n` is the FULL buffer size, it copies at most `n-1` chars, and always null-terminates. So `ircd_strncpy(buf, src, 5)` copies only 4 chars. Use `sizeof(buf)` or `LEN + 1` (for a `buf[LEN+1]` declaration), never a bare `LEN`.

Audit rule: a bare `LEN` constant where the buffer is `LEN+1`, or a non-NUL-terminated source whose byte-length is passed as `n`, truncates by one char. Scan with a **paren-balanced parse** of each call — single-line grep misses calls whose size arg wraps to the next line. See the `project_strncpy_truncation_stragglers` memory entry for the two real-world bugs this caused.

## libkc / curl_multi Event Adapter

`ircd_kc_adapter.c` bridges libkc's curl_multi socket API with Nefarious's `ircd_events.h`.

- **FD recycling**: curl closes the DNS socket and opens the TCP socket with the same fd. Use `socket_reattach()` (ircd_events.c:687) to re-register with epoll — it preserves `gh_ref`/`gh_flags` and is safe during callbacks.
- **`socket_del` during callbacks is UNSAFE**: Nefarious's `event_add` == `event_execute` (synchronous, non-threaded). Calling `socket_del` mid-dispatch tears the socket down while `engine_loop` still holds a `gen_ref`, corrupting the synchronous ET_DESTROY chain. (`socket_del` sets `GEN_DESTROY`; `GEN_ACTIVE` is cleared in `event_execute` on the ET_DESTROY event, and the `gh_flags & GEN_ACTIVE` assertion lives there too.)
- **Simple removal**: defer to a 0-second timer (`TT_RELATIVE, 0`). `timer_run()` executes after `engine_loop`'s event dispatch, once all `gen_ref`s are released.
- **Never `memset` a Socket struct that has pending gen_refs** — it zeroes `gh_ref` and corrupts the synchronous ET_DESTROY event chain.

## Config File Parsing

### Block ordering (CRITICAL)

- `make_conf()` **prepends** to `GlobalConfList` (s_conf.c:153).
- `attach_iline()` returns the **first** match while walking the list.
- Therefore the **last** Client block in the file is checked **first** at runtime.
- **Catch-all blocks must come FIRST in the config file** (so they end up last in the list, checked last).
- Port-specific / more-specific blocks must come **after** the catch-all (so they're checked first).

### Syntax gotchas

- `include "file";` requires the trailing semicolon — `include "file"` without `;` causes cascading parse errors.
- A new parser token needs BOTH `TOKEN(FOO)` in the lexer AND `%token FOO` in the parser — missing either silently breaks parsing via error recovery.
- Editing host files that are bind-mounted into containers with atomic-rename editors (Claude Edit/Write, vim, VSCode) breaks the bind mount (container sees the old inode). Symptom: config changes "don't take effect" after REHASH. Fix: restart the container.

## Build / Test Workflow

- Build with `scripts/dc.sh -l up -d --build ...` (the wrapper sources `.env` + `.env.local`). The "NEVER build" rule applies only to **raw** `docker compose build` / `up --build`, which bypass `.env.local`. Building via the wrapper is allowed.
- 2-server rebuild: `scripts/dc.sh -l up -d --build nefarious nefarious2`.
- No local build environment — Docker is the only build path. Don't compile `.o` files locally; they contaminate the Docker COPY.
- Submodule commits go in the submodule dir (`nefarious/`); the parent repo tracks the submodule pointer.
- Stalls/hangs/"why isn't X firing": reach for an strace/gdb **sidecar** (no rebuild) first — `docker run --pid=container:X --cap-add SYS_PTRACE debian:13`.

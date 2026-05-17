# IAUTH SASL Mechanism List & CAP Integration

## Context

When X3 services disconnects, SASL capabilities should gracefully degrade to what IAUTH can provide rather than disappearing entirely. Currently:

- **X3 services** broadcasts mechanisms globally via P10: `SASL * * M :PLAIN,EXTERNAL,SCRAM-SHA-256`
- **IAUTH (iauthd-ts)** only sends mechanisms per-client via `l <id> <ip> <port> :PLAIN` (the `908 ERR_SASLMECHS` reply)
- When X3 disconnects, the mechanism list is cleared. If IAUTH handles SASL, we re-advertise `sasl` but **without a mechanism list**, so `CAP LS 302` shows `sasl` with no value instead of `sasl=PLAIN`

**Long-term**: Authentication will move entirely into Nefarious via the keycloak library (libkc). IAUTH is the interim bridge. This plan makes IAUTH behave correctly until that migration.

## Architecture

### Current SASL mechanism sources

```
                    ┌─────────────┐
                    │   CAP LS    │
                    │ sasl=MECHS  │
                    └──────┬──────┘
                           │ reads
                    ┌──────▼──────┐
                    │ SaslMechs[] │  (global in ircd.c)
                    └──────┬──────┘
                           │ set by
              ┌────────────┴────────────┐
              │                         │
     ┌────────▼────────┐    ┌──────────▼──────────┐
     │  X3 Services    │    │  IAUTH (iauthd-ts)  │
     │ SASL * * M :... │    │  (no global mechs)  │
     └─────────────────┘    └─────────────────────┘
```

### Target state

```
                    ┌─────────────┐
                    │   CAP LS    │
                    │ sasl=MECHS  │
                    └──────┬──────┘
                           │ reads (services mechs preferred, fallback to iauth)
                    ┌──────▼──────┐
                    │ SaslMechs[] │  (global, set by services OR iauth)
                    └──────┬──────┘
                           │ set by
              ┌────────────┴────────────┐
              │                         │
     ┌────────▼────────┐    ┌──────────▼──────────┐
     │  X3 Services    │    │  IAUTH (iauthd-ts)  │
     │ SASL * * M :... │    │  M :PLAIN (new!)    │
     │  (primary)      │    │  (fallback)         │
     └─────────────────┘    └─────────────────────┘
```

When X3 is connected, its mechanism list takes priority (it supports PLAIN, EXTERNAL, SCRAM-SHA-256, etc.). When X3 disconnects and IAUTH has SASL, IAUTH's mechanism list is used for `CAP LS`.

## Implementation

### Step 1: New IAuth protocol command — global mechanism broadcast

**File**: `nefarious/ircd/s_auth.c`

Add a new IAuth command `'M'` (uppercase, distinct from `'m'` which is mark) that stores global SASL mechanisms:

```c
// New handler: stores mechanism list in iauth->i_sasl_mechs
static int iauth_cmd_sasl_global_mechs(struct IAuth *iauth, struct Client *cli,
                                        int parc, char **params)
{
  if (EmptyString(params[0])) {
    iauth->i_sasl_mechs[0] = '\0';
    return 0;
  }
  ircd_strncpy(iauth->i_sasl_mechs, params[0], sizeof(iauth->i_sasl_mechs) - 1);
  iauth->i_sasl_mechs[sizeof(iauth->i_sasl_mechs) - 1] = '\0';

  /* If services hasn't set mechanisms yet, use IAUTH's list for CAP LS */
  if (!get_sasl_mechanisms())
    set_sasl_mechanisms(iauth->i_sasl_mechs);

  return 0;
}
```

**Note**: `'M'` is unused in the dispatch table. `'m'` = mark (per-client), `'M'` = usermode (per-client). Need to pick a free letter.

Looking at the dispatch table:
- Used (no-client): `>`, `G`, `O`, `V`, `a`, `A`, `s`, `S`, `X`
- Used (per-client): `o`, `U`, `u`, `N`, `I`, `m`, `M`, `C`, `d`, `D`, `R`, `k`, `K`, `r`, `c`, `L`, `f`, `l`, `Z`

**Available no-client letters**: `B`, `E`, `F`, `H`, `J`, `P`, `Q`, `T`, `W`, `Y`, `b`, `e`, `g`, `h`, `i`, `j`, `n`, `p`, `q`, `t`, `v`, `w`, `x`, `y`, `z`

Use `'W'` for "What mechanisms" (global broadcast, no-client context needed).

Register in dispatch switch:
```c
case 'W': handler = iauth_cmd_sasl_global_mechs; has_cli = 0; break;
```

### Step 2: Declare `auth_iauth_sasl_mechs()` in header

**File**: `nefarious/include/s_auth.h`

Add after `auth_iauth_handles_sasl()`:
```c
extern const char *auth_iauth_sasl_mechs(void);
```

(The function body already exists in s_auth.c from the previous session.)

### Step 3: Update services disconnect handler

**File**: `nefarious/ircd/list.c`

When services disconnects and IAUTH handles SASL, use IAUTH's mechanism list:

```c
if (auth_iauth_handles_sasl()) {
  const char *iauth_mechs = auth_iauth_sasl_mechs();
  log_write(LS_SYSTEM, L_INFO, 0,
            "Services disconnect: IAUTH still handles SASL%s%s (%C)",
            iauth_mechs ? ", mechanisms: " : "",
            iauth_mechs ? iauth_mechs : "", cptr);
  set_sasl_mechanisms(NULL);  /* Clear services mechs first */
  if (iauth_mechs)
    set_sasl_mechanisms(iauth_mechs);  /* Set IAUTH mechs → CAP NEW :sasl=PLAIN */
  else
    send_cap_notify("sasl", 1, NULL);  /* Re-advertise without list */
}
```

### Step 4: iauthd-ts sends global mechanisms on startup

**File**: `nefarious/tools/iauthd-ts/src/iauth.ts`

In `handleStartup()`, after sending policy, if SASL is enabled (policy includes 'S'), send the global mechanism list:

```typescript
private handleStartup(): void {
  this.send('G 1');
  this.send(`V :Nefarious2 iauthd-ts version ${VERSION}`);
  this.send(`O ${this.config.policy}`);

  // If SASL enabled, broadcast supported mechanisms globally
  if (this.saslEnabled()) {
    const mechs = getSupportedMechanisms().join(',');
    this.send(`W :${mechs}`);
  }

  this.sendNewConfig();
  this.debug('Starting up');
  this.sendStats();
}
```

### Step 5: Auth provider mechanism aggregation

Currently `getSupportedMechanisms()` returns hardcoded `['PLAIN']`. This should be derived from the configured auth providers. All current providers (file, LDAP, Keycloak) only support PLAIN (password-based), so this is correct for now. When providers support additional mechanisms, this function should aggregate them.

**No code change needed now** — just document the limitation.

### Step 6: Handle IAUTH reconnect/restart

When IAUTH reconnects (policy resent), if services is not connected, IAUTH's mechanisms should be applied:

This is already handled by Step 1 — `iauth_cmd_sasl_global_mechs` checks `get_sasl_mechanisms()` and sets if empty.

### Step 7: Prevent IAUTH from overriding services

When services IS connected (mechanisms already set), IAUTH's `W` command should NOT override. Step 1 already handles this with the `if (!get_sasl_mechanisms())` check. But we also need to handle when services connects AFTER IAUTH:

In `m_sasl.c` where `SASL * * M :PLAIN,EXTERNAL,...` is handled — this already calls `set_sasl_mechanisms()` unconditionally, which overrides whatever IAUTH set. This is correct since services has the richer mechanism list.

**No code change needed** — services always wins.

## Files to modify

| File | Change |
|------|--------|
| [s_auth.c](nefarious/ircd/s_auth.c) | Add `iauth_cmd_sasl_global_mechs` handler, register `'W'` in dispatch |
| [s_auth.h](nefarious/include/s_auth.h) | Declare `auth_iauth_sasl_mechs()` |
| [list.c](nefarious/ircd/list.c) | Update disconnect handler to use IAUTH mechs |
| [iauth.ts](nefarious/tools/iauthd-ts/src/iauth.ts) | Send `W :PLAIN` during startup when SASL enabled |

## Testing

1. Start with IAUTH SASL enabled (`#IAUTH POLICY SRTAWUwFr`), X3 connected
   - `CAP LS 302` should show `sasl=PLAIN,EXTERNAL,SCRAM-SHA-256,...` (from X3)
2. Stop X3 (`docker compose stop x3`)
   - Clients should get `CAP DEL :sasl` then `CAP NEW :sasl=PLAIN` (from IAUTH)
3. Start X3 again
   - Clients should get `CAP DEL :sasl` then `CAP NEW :sasl=PLAIN,EXTERNAL,...` (from X3)
4. SASL PLAIN auth should work via IAUTH when X3 is down

## Non-goals (future work)

- Moving Keycloak SASL into Nefarious directly (libkc integration)
- SCRAM-SHA-256 support in IAUTH (requires server-side state)
- EXTERNAL (cert) support in IAUTH
- OAUTHBEARER in IAUTH

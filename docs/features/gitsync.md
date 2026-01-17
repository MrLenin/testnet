# Native GitSync

Native git-based configuration distribution for Nefarious IRCd using libgit2.

**Branch**: `feature/native-dnsbl-gitsync`

## Overview

GitSync replaces the shell-based `gitsync.sh` script with a native C implementation using libgit2. This provides better performance, security (no shell spawning), and integration with the IRCd.

## Architecture

```
┌─────────────────┐
│  Git Repository │  (Gitolite/GitHub/GitLab)
│  - linesync.data│
│  - cert tags    │
└────────┬────────┘
         │ SSH (libgit2)
         ▼
┌─────────────────┐
│   Nefarious     │
│  - Periodic sync│
│  - TOFU host key│
│  - Cert loading │
└─────────────────┘
```

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `FEAT_GITSYNC_ENABLE` | FALSE | Enable native GitSync |
| `FEAT_GITSYNC_INTERVAL` | 3600 | Sync interval (seconds) |
| `FEAT_GITSYNC_REPOSITORY` | "" | Git repo URL (SSH format) |
| `FEAT_GITSYNC_BRANCH` | "master" | Branch to track |
| `FEAT_GITSYNC_SSH_KEY` | "" | SSH private key path |
| `FEAT_GITSYNC_LOCAL_PATH` | "linesync" | Local clone directory |
| `FEAT_GITSYNC_CONF_FILE` | "linesync.data" | Config file in repo |
| `FEAT_GITSYNC_CERT_TAG` | "" | Git tag for SSL cert |
| `FEAT_GITSYNC_CERT_FILE` | "" | Cert output path (defaults to SSL_CERTFILE) |
| `FEAT_GITSYNC_HOST_FINGERPRINT` | "" | Known host key (TOFU) |

## GITSYNC Oper Command

```
GITSYNC FORCE   - Trigger immediate sync
GITSYNC STATUS  - Show sync status (hash, last sync, interval)
GITSYNC PUBKEY  - Display SSH public key for repo access config
GITSYNC HOSTKEY - Display known host fingerprint
GITSYNC ACCEPT <fingerprint> - Accept host key (TOFU)
```

## P10 Protocol

**Token**: `GS` (GITSYNC)

**Format**:
```
[OPER] GS <subcmd> [params...]
```

**Subcommands**:

| Subcmd | Purpose |
|--------|---------|
| `F` | Force sync |
| `S` | Status request |
| `P` | Get public key |
| `H` | Get host fingerprint |
| `A` | Accept host key |
| `R` | Result callback |

## Certificate Tags

GitSync can distribute SSL certificates via git tags:

1. Create a tag pointing to certificate content:
   ```bash
   git tag -f servername-cert $(cat fullchain.pem | git hash-object -w --stdin)
   git push origin servername-cert
   ```

2. Configure IRCd:
   ```
   features {
       "GITSYNC_CERT_TAG" = "servername-cert";
   };
   ```

3. On sync, certificate is extracted and written to CERT_FILE

## TOFU (Trust On First Use)

On first connection to a new git server:

1. GitSync reports unknown host key via oper notice
2. Oper verifies fingerprint out-of-band
3. Oper runs: `GITSYNC ACCEPT <fingerprint>`
4. Fingerprint stored in HOST_FINGERPRINT for future connections

## Build Requirements

```bash
./configure --with-gitsync
```

Requires: `libgit2-dev`, `libssh2-1-dev`

## Example Configuration

```
features {
    "GITSYNC_ENABLE" = "TRUE";
    "GITSYNC_REPOSITORY" = "git@git.example.org:irc/linesync-data.git";
    "GITSYNC_BRANCH" = "master";
    "GITSYNC_SSH_KEY" = "/path/to/ircd.pem";
    "GITSYNC_INTERVAL" = "3600";
    "GITSYNC_CERT_TAG" = "testnet-cert";
};
```

---

*Part of the Nefarious IRCd IRCv3.2+ upgrade project.*

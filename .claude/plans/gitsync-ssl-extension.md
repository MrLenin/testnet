# GitSync SSL/SNI Certificate Management Extension

## Status: PLANNING

## Overview

Extend GitSync to manage SSL block configurations and multiple SNI certificates across servers.

---

## Existing Functionality

GitSync already has single-certificate distribution via git tags:

| Feature Flag | Default | Description |
|--------------|---------|-------------|
| `FEAT_GITSYNC_CERT_TAG` | "" | Git tag pointing to certificate blob |
| `FEAT_GITSYNC_CERT_FILE` | "" | Output path (defaults to SSL_CERTFILE) |

**How it works:**
1. Create a git tag pointing to certificate content:
   ```bash
   git tag -f servername-cert $(cat fullchain.pem | git hash-object -w --stdin)
   git push origin servername-cert
   ```
2. Configure: `"GITSYNC_CERT_TAG" = "servername-cert";`
3. On sync, `gitsync_update_cert()` extracts blob content to `GITSYNC_CERT_FILE`
4. If cert changed, triggers SSL reload

This handles the **default** certificate. SNI support needs multiple certs per hostname.

---

## Use Cases

1. **Centralized SNI config**: Manage `SSL {}` blocks in a shared config repo
2. **Certificate distribution**: Sync certificate files for each SNI hostname
3. **Consistent multi-server TLS**: All servers serve same certificates for same hostnames
4. **Certificate rotation**: Update certs in git, push, all servers pick up new certs

---

## Proposed Extension

### Option A: Hostname-Based Cert Tags (Recommended)

Extend existing tag mechanism to support multiple SNI hostnames:

**Convention**: For each hostname in `SSL {}` block, look for corresponding tags:
- `<hostname>.crt` - Certificate tag
- `<hostname>.key` - Private key tag

**Example:**
```
SSL {
    "irc.example.net" {
        certificate = "/etc/ircd/certs/irc.example.net.crt";
        key = "/etc/ircd/certs/irc.example.net.key";
    };
    "server.example.net" {
        certificate = "/etc/ircd/certs/server.example.net.crt";
        key = "/etc/ircd/certs/server.example.net.key";
    };
};
```

GitSync looks for tags: `irc.example.net.crt`, `irc.example.net.key`, `server.example.net.crt`, `server.example.net.key`

**New feature flags:**
```
features {
    "GITSYNC_SNI_CERT_SYNC" = "TRUE";   /* Enable SNI cert sync */
    "GITSYNC_SNI_CERT_DIR" = "/etc/ircd/certs";  /* Output directory */
};
```

**Implementation:**
```c
static void gitsync_sync_sni_certs(git_repository *repo)
{
    struct SSLCertConf *conf;
    char tag_name[256];
    char out_path[512];
    const char *cert_dir = feature_str(FEAT_GITSYNC_SNI_CERT_DIR);

    if (!feature_bool(FEAT_GITSYNC_SNI_CERT_SYNC))
        return;
    if (EmptyString(cert_dir))
        return;

    /* Ensure cert directory exists */
    mkdir(cert_dir, 0700);

    /* Iterate over SSL block hostnames */
    for (conf = sslCertConfList; conf; conf = conf->next) {
        /* Look for hostname.crt tag */
        ircd_snprintf(0, tag_name, sizeof(tag_name), "%s.crt", conf->hostname);
        ircd_snprintf(0, out_path, sizeof(out_path), "%s/%s.crt", cert_dir, conf->hostname);
        gitsync_update_cert_to_file(repo, tag_name, out_path);

        /* Look for hostname.key tag */
        ircd_snprintf(0, tag_name, sizeof(tag_name), "%s.key", conf->hostname);
        ircd_snprintf(0, out_path, sizeof(out_path), "%s/%s.key", cert_dir, conf->hostname);
        gitsync_update_cert_to_file(repo, tag_name, out_path);
    }
}
```

**Pros:**
- Natural extension of existing cert tag mechanism
- No config changes needed beyond enabling the feature
- Hostnames in SSL block drive which tags to fetch
- Only syncs certs for hostnames actually configured

**Cons:**
- Must create individual tags for each cert/key
- Tag names tied to hostnames

### Option B: Cert Directory Sync

Sync entire `certs/` directory from repo:

```
features {
    "GITSYNC_CERT_DIR_SYNC" = "TRUE";
    "GITSYNC_CERT_DIR" = "/etc/ircd/certs";
};
```

GitSync copies all files from `certs/` in repo to local `GITSYNC_CERT_DIR`.

**Pros:**
- Simple implementation
- Can include any files (CA certs, intermediates)

**Cons:**
- Syncs ALL certs even if not used
- Less precise than tag-based approach

---

## Recommended Approach

### Phase 1: Config-Only Sync (Ready Now)

Current GitSync already supports SSL config sync:
1. Create `ssl.conf` file in git repo with SSL blocks
2. Add `include "ssl.conf";` to main config
3. Deploy certificate files to consistent paths on all servers (out-of-band)
4. GitSync syncs the SSL block config
5. SIGUSR1/rehash reloads new SNI configurations

### Phase 2: Hostname-Based Cert Tags (New)

**Follows existing pattern**: Each server fetches cert tags for the hostnames IT is configured to serve.

The existing `GITSYNC_CERT_TAG` pattern:
1. Repo has per-server cert tags: `hub1-cert`, `leaf1-cert`, etc.
2. Each server sets `GITSYNC_CERT_TAG` to its own tag
3. Let's Encrypt renewal → update tag blob → servers fetch on next sync

**SNI extension**: Same pattern, but for each hostname in the server's SSL {} block:

**Git repo structure:**
```
linesync-data/
├── linesync.data
└── tags:
    ├── hub1-cert           # Default cert for hub1 (existing)
    ├── leaf1-cert          # Default cert for leaf1 (existing)
    ├── irc.network.net.crt # SNI cert (new)
    ├── irc.network.net.key # SNI key (new)
    ├── leaf1.network.net.crt
    ├── leaf1.network.net.key
    └── ...
```

**Server config (local.conf on leaf1):**
```
features {
    "GITSYNC_ENABLE" = "TRUE";
    "GITSYNC_CERT_TAG" = "leaf1-cert";       # Default cert (existing)
    "GITSYNC_SNI_CERT_SYNC" = "TRUE";        # Enable SNI cert sync (new)
};

SSL {
    "leaf1.network.net" {
        certificate = "/etc/ircd/certs/leaf1.network.net.crt";
        key = "/etc/ircd/certs/leaf1.network.net.key";
    };
    "irc.network.net" {
        certificate = "/etc/ircd/certs/irc.network.net.crt";
        key = "/etc/ircd/certs/irc.network.net.key";
    };
};
```

GitSync on leaf1 fetches:
- `leaf1-cert` tag → default SSL cert (existing behavior)
- `leaf1.network.net.crt` + `.key` tags → SNI cert (new)
- `irc.network.net.crt` + `.key` tags → SNI cert (new)

**Let's Encrypt renewal workflow:**
```bash
# After certbot renewal, update tags for all hostnames
for host in irc.network.net leaf1.network.net leaf2.network.net; do
    git tag -f "${host}.crt" $(cat "/etc/letsencrypt/live/${host}/fullchain.pem" | git hash-object -w --stdin)
    git tag -f "${host}.key" $(cat "/etc/letsencrypt/live/${host}/privkey.pem" | git hash-object -w --stdin)
done
git push origin --tags --force
```

**Files to modify:**

| File | Changes |
|------|---------|
| `include/ircd_features.h` | Add `FEAT_GITSYNC_SNI_CERT_SYNC` |
| `ircd/ircd_features.c` | Register new feature flag |
| `ircd/gitsync.c` | Add `gitsync_sync_sni_certs()` iterating over `sslCertConfList` |

### Phase 3: Secure Certificate Handling (Future)

For production environments with security requirements:
1. Encrypt private keys in repo with age/sops
2. Decrypt on pull using server's SSH key
3. Store decrypted keys in memory-only tmpfs

---

## Implementation Details

### Refactor gitsync_update_cert()

Extract file-writing logic to reusable function:

```c
/* Write blob from tag to file, returns 1 if changed */
static int
gitsync_update_cert_to_file(git_repository *repo, const char *tag_name, const char *out_file)
{
    /* Existing gitsync_update_cert() logic, but parameterized */
}

/* Existing function, uses default cert file */
static void
gitsync_update_cert(git_repository *repo, const char *tag_name)
{
    const char *cert_file = feature_str(FEAT_GITSYNC_CERT_FILE);
    if (!cert_file || !*cert_file)
        cert_file = feature_str(FEAT_SSL_CERTFILE);

    gitsync_update_cert_to_file(repo, tag_name, cert_file);
}
```

### SNI Cert Sync Implementation

Iterate over the server's `sslCertConfList` and fetch cert/key tags for each configured hostname:

```c
/* Sync SNI certificates from git tags based on server's SSL {} config */
static void
gitsync_sync_sni_certs(git_repository *repo)
{
    struct SSLCertConf *conf;
    char tag_name[256];
    int any_changed = 0;

    if (!feature_bool(FEAT_GITSYNC_SNI_CERT_SYNC))
        return;

    /* Iterate over this server's configured SNI hostnames */
    for (conf = sslCertConfList; conf; conf = conf->next) {
        if (EmptyString(conf->hostname) || EmptyString(conf->certfile) || EmptyString(conf->keyfile))
            continue;

        /* Fetch hostname.crt tag → certfile path */
        ircd_snprintf(0, tag_name, sizeof(tag_name), "%s.crt", conf->hostname);
        any_changed |= gitsync_update_cert_to_file(repo, tag_name, conf->certfile);

        /* Fetch hostname.key tag → keyfile path */
        ircd_snprintf(0, tag_name, sizeof(tag_name), "%s.key", conf->hostname);
        any_changed |= gitsync_update_cert_to_file(repo, tag_name, conf->keyfile);
    }

    /* If any certs changed, trigger SSL reload */
    if (any_changed) {
        ssl_reinit();
    }
}
```

### Call Order in gitsync_sync()

```c
/* In gitsync_sync(), after git pull: */
#ifdef USE_SSL
    /* Sync default certificate (existing) */
    const char *cert_tag = feature_str(FEAT_GITSYNC_CERT_TAG);
    if (cert_tag && *cert_tag) {
        gitsync_update_cert(repo, cert_tag);
    }

    /* Sync SNI certificates for this server's configured hostnames (new) */
    gitsync_sync_sni_certs(repo);
#endif
```

### Why This Works

Each server only fetches certs for hostnames IT is configured to serve:
- leaf1 has SSL block for `leaf1.network.net` → fetches that tag
- hub1 has SSL block for `irc.network.net` → fetches that tag
- If a server serves multiple hostnames, it fetches all of them

The cert tags live in the shared repo, but each server only pulls what it needs based on its own config.

---

## Security Considerations

1. **Private keys in git**: Use git tags (not tracked files) - tags can be force-pushed without history
2. **File permissions**: Cert directory 0700, key files 0600
3. **TOFU for git server**: GitSync already has host key verification
4. **Audit trail**: Git reflog tracks tag changes
5. **Revocation**: Remove tag, push, certs no longer sync

---

## Testing Plan

1. **Phase 1 (Config-Only)**:
   - Create SSL block in included config file
   - Verify GitSync pulls updated config
   - Verify rehash loads new SNI certificates

2. **Phase 2 (Cert Tags)**:
   - Create cert/key tags for test hostnames
   - Configure GITSYNC_SNI_CERT_SYNC
   - Verify certs written to GITSYNC_SNI_CERT_DIR
   - Verify SSL reload triggered on cert change
   - Test missing tag handling (should log warning, not fail)

---

## Decision Points

1. **Tag naming convention**: `hostname.crt`/`hostname.key` vs `hostname-cert`/`hostname-key`?
2. **Missing tag behavior**: Silent skip vs warning vs error?
3. **Reload strategy**: Per-cert reload vs batch reload after all synced?

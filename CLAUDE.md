# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Afternet Testnet is a Docker-based IRC test environment running:
- **Nefarious IRCd** - IRC server daemon (git submodule from evilnet/nefarious2)
- **X3 Services** - Channel/nickname services (git submodule from evilnet/x3, branch `rubin-add_docker`)

## Build & Run Commands

```bash
# Build and start
docker compose build
docker compose up -d

# View logs
docker compose logs -f
docker compose logs nefarious
docker compose logs x3

# Stop
docker compose down
```

## Submodule Management

```bash
# Initialize (if cloned without --recurse-submodules)
git submodule update --init --recursive

# Update to latest remote
git submodule update --remote --merge

# Work on a submodule
cd nefarious  # or x3
git checkout -b feature-branch
# make changes, commit, push
cd ..
git add nefarious
git commit -m "Update nefarious submodule"
```

## Architecture

### Configuration System
Both services use environment variable templating:
1. Template files (`.conf-dist`) contain `%VARIABLE_NAME%` placeholders
2. Docker entry points (`dockerentrypoint.sh`) substitute environment variables via sed
3. Final configs written at container startup

Key config files:
- `.env` - X3 environment variables
- `nefarious/tools/docker/base.conf-dist` - IRCd config template
- `x3/docker/x3.conf-dist` - X3 config template

### Docker Structure
- Both containers built on Debian 12 using GNU Autotools
- Run as non-root user (UID/GID 1234)
- Docker bridge network: IPv4 10.1.2.0/24, IPv6 fec0:3200::1/64

### Ports
- 6667: IRC (plaintext)
- 4497: IRC (SSL)
- 9998: Services link

### Entry Points
- `nefarious/tools/docker/dockerentrypoint.sh` - Generates SSL certs, substitutes config
- `x3/docker/dockerentrypoint.sh` - Substitutes config

## Project Status

Work in progress - recently converted to git submodules. The `archive/` directory contains pre-submodule versions (can be ignored). X3 tracks a custom fork branch (`rubin-add_docker`) with Docker enhancements.
- dont build the containers yourself, it eats too much tokens watching make go by
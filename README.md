# Afternet Testnet

A Docker-based test environment for running [Nefarious IRCd](https://github.com/evilnet/nefarious2) and [X3 Services](https://github.com/evilnet/x3) together.

## Prerequisites

- Git
- Docker and Docker Compose
- SSH key configured for GitHub (for x3 submodule)

## Getting Started

### 1. Clone the Repository

```bash
git clone --recurse-submodules git@github.com:evilnet/testnet.git
cd testnet
```

If you already cloned without `--recurse-submodules`, initialize the submodules:

```bash
git submodule update --init --recursive
```

### 2. Configuration

Configuration files are stored in `data/` and mounted directly into containers:

- `data/local.conf` - Nefarious IRCd configuration (mounted to container)
- `data/x3.conf` - X3 services configuration (mounted to container)
- `.env` - Environment variables (mostly unused; configs are hardcoded in the above files)
- `.env.local` - Local overrides (not committed to repo)

### 3. Build and Run

```bash
# Build the containers
docker compose build

# Start the services
docker compose up -d

# View logs
docker compose logs -f
```

### 4. Connect

Once running, you can connect to the IRC server:

- **Host:** `localhost`
- **Port:** `6667` (plain) or `4497` (SSL)

## Project Structure

```
testnet/
├── docker-compose.yml    # Docker orchestration
├── .env                  # Environment variables (mostly unused)
├── nefarious/            # Nefarious IRCd (git submodule)
├── x3/                   # X3 Services (git submodule)
├── data/                 # Configuration files (committed)
│   ├── local.conf        # Nefarious IRCd config
│   └── x3.conf           # X3 services config
└── tests/                # Integration tests
```

## Submodules

This repository uses git submodules for the main components:

| Submodule | Repository | Branch |
|-----------|------------|--------|
| nefarious | https://github.com/evilnet/nefarious2 | default |
| x3 | git@github.com:evilnet/x3.git | rubin-add_docker |

### Updating Submodules

To pull the latest changes from upstream:

```bash
git submodule update --remote --merge
```

## Exposed Ports

| Port | Service |
|------|---------|
| 6667 | IRC (plain) |
| 9998 | IRC (SSL) |
| 4497 | Services link |

## Troubleshooting

### Submodule issues

If submodules appear empty after cloning:

```bash
git submodule update --init --recursive
```

### Container won't start

Check the logs for errors:

```bash
docker compose logs nefarious
```

### Permission issues

The containers run as UID/GID 1234. Ensure mounted volumes have appropriate permissions.

## Development

To make changes to the submodules:

```bash
cd nefarious  # or x3
git checkout -b my-feature
# make changes
git commit -am "My changes"
git push origin my-feature
```

Then update the parent repo to track the new commit:

```bash
cd ..
git add nefarious  # or x3
git commit -m "Update nefarious submodule"
```

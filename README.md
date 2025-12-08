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

The environment uses these configuration files:

- `.env` - Environment variables for X3 configuration
- `docker-compose.yml` - Docker service definitions
- `data/nefarious/ircd_local.conf` - Nefarious local configuration (mounted as volume)

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
├── .env                  # Environment variables
├── nefarious/            # Nefarious IRCd (git submodule)
├── x3/                   # X3 Services (git submodule)
└── data/                 # Runtime configuration data
    └── nefarious/
        └── ircd_local.conf
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

## Network Configuration

The Docker network is configured with both IPv4 and IPv6:

- **IPv4 subnet:** `10.1.2.0/24`
- **IPv6 subnet:** `fec0:3200::1/64`
- **Nefarious IPv6:** `fec0:3200::99`

## Exposed Ports

| Port | Service |
|------|---------|
| 6667 | IRC (plain) |
| 4497 | IRC (SSL) |
| 9998 | Services link |

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

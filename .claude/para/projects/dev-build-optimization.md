# Dev Build Optimization Plan

## Problem

Every source change requires a full `docker compose build` which re-runs `COPY . /home/nefarious/nefarious2` invalidating the layer cache, then re-runs `./configure`, `make` (full recompile), `make test`, and `make install`. Same story for X3. This takes several minutes per iteration and burns Claude session tokens when waiting.

Both Dockerfiles also merge build-time and runtime concerns into a single stage, meaning dev tooling (gdb, valgrind, vim) is always included and build artifacts can't be cached independently.

## Current Build Flow (Nefarious)

```
1. apt-get install (cached if deps unchanged)
2. Build libkc from COPY --from=libkc (cached if libkc unchanged)
3. Build libmdbx from COPY --from=libmdbx (cached if libmdbx unchanged)
4. COPY . /home/nefarious/nefarious2  <-- ANY source change invalidates from here
5. ./configure                         <-- re-runs every time
6. make                                <-- full recompile every time
7. make test                           <-- re-runs every time
8. make install
9. Build iauthd-ts (npm install + build)
10. rm -rf source + build-essential    <-- cleanup for image size
11. COPY config files
```

## Proposed: Multi-stage with Dev Target

### Strategy A: Dev Volume Mount (Fastest Iteration)

Use a "dev" target that skips the source COPY entirely. Instead, mount the source tree and build artifacts as volumes. `make` runs incrementally inside the container.

```dockerfile
# Stage: base — deps + libraries (rarely changes)
FROM debian:12 AS base
# ... apt-get, libkc, libmdbx (same as today)

# Stage: configured — run ./configure once, cache the output
FROM base AS configured
COPY configure configure.in acinclude.m4 Makefile.in ircd/Makefile.in include/ /src/
WORKDIR /src
RUN ./configure --libdir=... --enable-debug --with-maxcon=4096 --with-mdbx=/usr --with-zstd=/usr --enable-keycloak

# Stage: dev — mount source, incremental make
FROM base AS dev
# ./configure output + Makefiles copied from configured stage
COPY --from=configured /src/config.h /src/config.status /src/Makefile /src/ircd/Makefile ...
# Source mounted at runtime via docker-compose volume
# Entrypoint: make && make install && exec ircd
```

docker-compose.yml (dev override):
```yaml
services:
  nefarious:
    build:
      target: dev
    volumes:
      - ./nefarious:/home/nefarious/nefarious2
      - nef-build-cache:/home/nefarious/nefarious2/ircd  # .o files persist
```

**Pros**: Sub-second recompile for single-file changes, `make` only rebuilds changed `.o` files.
**Cons**: More complex compose setup, need to handle `./configure` reruns manually.

### Strategy B: Smarter Layer Caching (Simpler)

Split the Dockerfile so `./configure` is cached when only `.c`/`.h` files change:

```dockerfile
# Stage 1: deps (cached unless Dockerfile changes)
FROM debian:12 AS deps
RUN apt-get ...

# Stage 2: configure (cached unless configure/m4/Makefile.in change)
FROM deps AS configure
COPY configure configure.in acinclude.m4 /src/
COPY Makefile.in ircd/Makefile.in include/config.h.in /src/
WORKDIR /src
RUN ./configure ...

# Stage 3: build (invalidated by source changes, but configure is cached)
FROM configure AS build
COPY . /src/
RUN make -j$(nproc)
RUN make test
RUN make install DESTDIR=/install

# Stage 4: runtime (slim, no build tools)
FROM debian:12-slim AS release
COPY --from=deps /usr/lib/libkc* /usr/lib/libmdbx* /usr/lib/
COPY --from=build /install/ /
```

**Pros**: `./configure` cached across source-only changes, multi-stage keeps image small.
**Cons**: Still full recompile on any source change (no incremental make).

### Strategy C: ccache (Middle Ground)

Add `ccache` to the build and persist its cache via a Docker volume or BuildKit cache mount:

```dockerfile
RUN apt-get install -y ccache
ENV PATH="/usr/lib/ccache:$PATH"
RUN --mount=type=cache,target=/home/nefarious/.ccache make -j$(nproc)
```

**Pros**: Near-instant rebuilds when only a few files change, minimal Dockerfile changes.
**Cons**: Requires BuildKit (`DOCKER_BUILDKIT=1`), cache volume management.

## Recommendation

**Combine B + C** for the best balance:
- Multi-stage separates configure from compile (Strategy B)
- ccache with BuildKit cache mount for incremental compilation (Strategy C)
- Optional `dev` target for volume-mount workflow during heavy iteration (Strategy A)

## X3 Considerations

Same patterns apply. X3's Dockerfile has the same `COPY . → autoconf → configure → make` pipeline. Key differences:
- X3 uses `autoconf && autoheader` before `./configure` (regenerates from `configure.in`)
- X3 has no test step in the build
- X3 build-essential cleanup is commented out (keeping dev tools in image)

## Additional Optimizations

- **Parallel make**: Both Dockerfiles use plain `make`. Change to `make -j$(nproc)`.
- **Combined RUN layers**: Multiple sequential `RUN apt-get` lines could be merged.
- **`.dockerignore`**: Ensure test artifacts, `.git`, `build.log`, etc. are excluded to avoid unnecessary cache invalidation.
- **iauthd-ts caching**: Separate `package.json` COPY + `npm install` from source COPY so node_modules is cached.

## Priority

Low — tackle after current bouncer fixes are stable. Build time is a quality-of-life issue, not a correctness issue.

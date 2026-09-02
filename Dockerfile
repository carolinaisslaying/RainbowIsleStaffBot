# node:26-bookworm-slim, not Alpine. resvg's musl builds are the flakier path
# and the image size difference does not matter for a single bot.
ARG NODE_IMAGE=node:26-bookworm-slim


# The dependency tree, resolved once.
#
# Split from the build stage so that editing a source file does not invalidate
# the install: this layer is keyed on the manifest, lockfile and pnpm settings
# alone.
FROM ${NODE_IMAGE} AS deps

WORKDIR /app

# pnpm, pinned, installed with npm.
#
# Pinned because the lockfile should be read by the pnpm that wrote it, and a
# floating version turns a reproducible build into a dated one. Installed with
# npm rather than through corepack: corepack's place in the Node distribution
# has been contested, and a build that depends on it fails on the deploy rather
# than on the laptop if a future base image drops it. `npm i -g pnpm` works on
# any Node image whatever it ships with.
ARG PNPM_VERSION=11.24.0
RUN npm i -g pnpm@${PNPM_VERSION}

# pnpm-workspace.yaml is not optional here. It carries the install-script
# allowlist, and pnpm checks that list before running any script -- so a build
# without this file fails at `pnpm build`, not at the install, which reads as a
# compiler problem rather than a missing config.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# `--frozen-lockfile` is pnpm's `npm ci`: it refuses to resolve anything the
# lockfile does not already pin, so a build can never quietly drift from what
# was tested. No BuildKit cache mount, so this file builds identically under the
# classic builder. That matters more than it sounds: `docker-compose` run under
# sudo cannot see a buildx plugin installed for your user, silently falls back
# to the classic builder, and a `--mount` flag then fails the build on the
# deploy rather than on the laptop. Docker's own layer cache already skips this
# step entirely unless one of the files above changed, so the mount only ever
# saved time on a dependency bump.
RUN pnpm install --frozen-lockfile


FROM ${NODE_IMAGE} AS build

WORKDIR /app

ARG PNPM_VERSION=11.24.0
RUN npm i -g pnpm@${PNPM_VERSION}

# pnpm's node_modules is a symlink farm into node_modules/.pnpm, and every one
# of those links is relative and inside the directory being copied -- so the
# tree moves between stages intact, exactly as npm's flat one did. The store's
# hardlinks become ordinary files in the process, which costs a little size and
# nothing else.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
RUN pnpm build

# Reduce the same tree to production dependencies rather than resolving and
# downloading the whole thing again in the runtime stage. Every stage here is
# the same base image on the same platform, so the pruned `node_modules` --
# resvg's prebuilt native binary included -- copies across as it stands.
RUN pnpm prune --prod


FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production

# resvg rasterises SVG text using system fonts, and the slim images ship none.
# Without this the ring percentages and every heatmap label render as nothing,
# which looks like a layout bug rather than a missing dependency.
#
# Inter carries the readouts. The rings are drawn in Apple's idiom and Apple's
# numerals are half of why that idiom reads the way it does; Inter is the
# closest face that can actually be shipped, and its tabular figures stop the
# percentage jittering as it counts up. DejaVu stays as the fallback, so a build
# that somehow lacks Inter renders text rather than nothing.
#
# No `fontconfig`, and no `fc-cache`. `FONT_OPTIONS` (`src/render/fonts.ts`)
# sets `loadSystemFonts: false` and names these two directories directly, so
# resvg builds its font database from them and never consults fontconfig. The
# package and the cache it built were paying for a lookup nothing performs.
#
# curl is here for the healthcheck alone; see HEALTHCHECK below for why.
#
# The two `test -d` lines are the point of the layer, and they have already
# earned it: Debian ships Inter as OTF under opentype/, `src/render/fonts.ts`
# was looking for it under truetype/, and because truetype/dejavu does exist the
# mismatch never raised anything -- every card simply rendered in the fallback
# face. If a font package moves its files again, the build fails here instead.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-inter fonts-dejavu-core curl \
    && rm -rf /var/lib/apt/lists/* \
    && test -d /usr/share/fonts/opentype/inter \
    && test -d /usr/share/fonts/truetype/dejavu

WORKDIR /app

# package.json is required at runtime, not for its dependency list but for
# `"type": "module"`: without it Node reads every .js in dist as CommonJS.
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Runs as the unprivileged node user that the base image already provides.
USER node

# Source maps are emitted, so they may as well be read: an unhandled rejection
# then points at the .ts line that caused it instead of at compiled output.
# Node resolves them lazily, when a stack is materialised, so an idle bot pays
# nothing. Drop this flag and `"sourceMap"` in tsconfig.json together if the
# image size ever matters more than a legible stack trace.
ENV NODE_OPTIONS=--enable-source-maps

# Shell form, because the port is configurable and exec form does not expand it.
#
# curl rather than `node -e`: the old check started a whole Node runtime every
# 30 seconds -- roughly 2,900 process starts a day, each allocating a heap to
# make one loopback request. curl does the same work in single digit
# milliseconds, and its ~5MB in the image is bought once rather than paid for
# forever.
#
# --start-interval polls every 3s until the first success, so a fresh container
# is marked healthy about as fast as it can be, and only then falls back to the
# one minute steady state.
HEALTHCHECK --interval=1m --timeout=3s --start-period=45s --start-interval=3s --retries=3 \
    CMD curl -fsS --max-time 3 "http://127.0.0.1:${API_PORT:-8080}/health" || exit 1

CMD ["node", "dist/index.js"]

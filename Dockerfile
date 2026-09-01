# node:26-bookworm-slim, not Alpine. resvg's musl builds are the flakier path
# and the image size difference does not matter for a single bot.
FROM node:26-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:26-bookworm-slim AS runtime

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
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-inter fonts-dejavu-core fontconfig \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Runs as the unprivileged node user that the base image already provides.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

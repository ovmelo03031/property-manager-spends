# Bun runs the TypeScript sources directly: no build step, no native modules (SQLite is bun:sqlite).
# Pinned by version and digest so rebuilds are reproducible and follow the 7-day release-age rule.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data SEED_DIR=/app/seed
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
# The bun user has uid/gid 1000, same as the previous node image, so existing ./data keeps working.
RUN mkdir -p /data /app/seed && chown -R bun:bun /data /app
USER bun
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD bun -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/server.ts"]

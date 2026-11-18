# the registry is bun-first, so the image is minimal: one official bun base
# plus the app. built for operators who run the service.
FROM oven/bun:latest

WORKDIR /home/bun/app

# .dockerignore keeps the context lean (git, node_modules, dist, data/)
COPY --chown=bun:bun . .

# frozen lockfile so rebuilds give the same dependency set; --production
# because the service only ships elysia at runtime
RUN bun install --frozen-lockfile --production \
  && mkdir -p data \
  && chown -R bun:bun /home/bun/app

USER bun
EXPOSE 8093

# curl is not guaranteed in the base image, so probe /health with bun itself
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:' + (process.env.PORT || '8093') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# the app entry is the Elysia server; PORT/PM_DATA_DIR/PM_API_KEY are read from env
ENTRYPOINT ["bun", "src/index.ts"]

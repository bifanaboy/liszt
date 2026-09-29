# Liszt. Node 24 native type-stripping, so there is no build step: the image
# ships the TypeScript sources and Node runs them directly.
#
# The image exists for local/CI reproducibility. PRODUCTION DEPLOYMENT IS THE
# systemd UNIT in deploy/liszt.service, not this container - see deploy/README.md.
FROM node:24-slim

# Run as a non-root user, and keep the catalogue on a volume so it outlives the
# container. The database is runtime state and is never baked into the image.
ENV NODE_ENV=production \
    LISZT_DB_PATH=/data/liszt.db \
    PORT=3000

WORKDIR /app

# Dependencies first so a source edit does not reinstall the tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

# The app binds 127.0.0.1 by design, so a container must be run with
# --network=host (or a published port plus a bind change) to be reachable.
# Liveness is gated, so a 401 here is the CORRECT and expected response.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/app.ts"]

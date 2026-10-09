# Digest-pinned: Docker Hub rate-limits anonymous tag lookups on shared Railway
# builder IPs (HTTP 429), which fails builds that never touch the app code.
# Pinning by digest skips the tag resolution step. To update Node, change both
# the tag comment and the digest, then commit.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production PORT=3000 LISZT_DB_PATH=/data/liszt.db LISZT_LISTEN_ADDR=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown -R node:node /app /data
COPY src ./src
COPY public ./public
COPY studio-links.default.json ./studio-links.default.json
USER node
EXPOSE 3000
CMD ["npm", "start"]

FROM node:24-bookworm-slim
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

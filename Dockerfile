FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
ENV PORT=3000 HOST=0.0.0.0 NODE_ENV=production DB_PATH=/data/sat.sqlite
EXPOSE 3000
USER node
CMD ["node", "server/index.mjs"]

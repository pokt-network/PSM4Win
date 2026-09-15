FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY config.js chart.js render-worker.js server.js openapi.json ./
EXPOSE 8080
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server.js"]

# ── Stage 1: instalar solo dependencias de producción ──
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: imagen final mínima ──
FROM node:20-alpine
WORKDIR /app

# Usuario sin privilegios
RUN addgroup -S app && adduser -S app -G app

# Copiar deps y código fuente
COPY --from=deps /app/node_modules ./node_modules
COPY src/    ./src/
COPY public/ ./public/
COPY package.json ./

# Directorios que se montarán como volúmenes
RUN mkdir -p /app/data /app/logs && chown -R app:app /app

USER app

EXPOSE 3000

# Health check — usa wget (incluido en alpine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENV NODE_ENV=production \
    PORT=3000

CMD ["node", "src/server.js"]

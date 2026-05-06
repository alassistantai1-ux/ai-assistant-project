FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json ./
RUN npm install --omit=dev

# Copy application source
COPY server.js ./
COPY data/ ./data/
COPY public/ ./public/

# Non-root user for security
RUN addgroup -S aidwatch && adduser -S aidwatch -G aidwatch
USER aidwatch

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]

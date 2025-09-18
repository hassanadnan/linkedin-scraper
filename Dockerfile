# Use the official Playwright image with browsers preinstalled
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY src ./src

# Playwright browsers already bundled in this image
# Expose the port (Railway sets PORT env automatically)
ENV NODE_ENV=production

# Non-root user recommended by Playwright image
USER pwuser

CMD ["node", "src/server.js"]


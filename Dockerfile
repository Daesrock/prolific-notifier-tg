FROM mcr.microsoft.com/playwright:v1.59.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

RUN mkdir -p /app/data

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]

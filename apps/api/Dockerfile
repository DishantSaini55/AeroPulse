FROM node:22-bookworm-slim AS build
WORKDIR /workspace/apps/api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci
COPY apps/api ./
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /workspace/apps/api
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /workspace/apps/api ./
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]

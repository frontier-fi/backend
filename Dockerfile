# Build with bun (matches the lockfile), run with node (matches package.json "start").
FROM oven/bun:1-debian AS build
WORKDIR /app

# prisma generate reads the url from the schema and does not connect.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"

COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

COPY . .
# GraphQL clients are gitignored. DigitalOcean builds this image from git, so
# codegen has to run here. Subgraph outputs are introspected from the Sepolia URLs.
RUN PORT=4000 NODE_ENV=local DEPLOYMENT_ENV=canary ADMIN_API_KEY=build \
    bunx prisma generate --schema prisma/schema \
    && bun run generate \
    && bun run build

# production node_modules only (keeps the prisma CLI for the pre-deploy migrate job)
RUN rm -rf node_modules && bun install --frozen-lockfile --production && bunx prisma generate --schema prisma/schema

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./
RUN touch .env

EXPOSE 8080
CMD ["node", "dist/apps/main.js"]

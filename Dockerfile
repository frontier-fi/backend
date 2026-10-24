# Build with bun (matches the lockfile), run with node (matches package.json "start").
# CI installs the Bun version of this line, so Dependabot bumps both together.
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e AS build
WORKDIR /app

# prisma generate reads the url from the schema and does not connect.
# codegen imports the Sepolia config, which loads apps/env.ts at import time.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public" \
    PORT=4000 \
    NODE_ENV=staging \
    DEPLOYMENT_ENV=staging

COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

COPY . .
# GraphQL clients are gitignored, so codegen runs here. Subgraph outputs are
# introspected from the Sepolia URLs. apps/env.ts also requires an admin key: its placeholder
# goes on the command, because BuildKit flags ENV names that look like secrets.
RUN bunx prisma generate --schema prisma/schema \
    && ADMIN_API_KEY=build bun run generate \
    && bun run build

# production node_modules only (keeps the prisma CLI for the pre-deploy migrate job)
RUN rm -rf node_modules && bun install --frozen-lockfile --production && bunx prisma generate --schema prisma/schema

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
LABEL org.opencontainers.image.source="https://github.com/frontier-fi/backend"
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./

# The files stay owned by root, so the app cannot change its own code.
USER node
EXPOSE 8080
CMD ["node", "dist/apps/main.js"]

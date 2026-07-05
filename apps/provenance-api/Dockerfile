# Build context is the MONOREPO ROOT (so workspace deps resolve).
#   docker build -f apps/provenance-api/Dockerfile -t provenance-api .
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Install the whole workspace (tsx runs TS directly — no build step).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/provenance-api ./apps/provenance-api
RUN pnpm install --frozen-lockfile --prod=false

ENV PORT=8402
EXPOSE 8402
# Holds NO secrets — configure PROVENANCE_PAYTO / PRICE_USDC via env if desired.
CMD ["pnpm", "--filter", "provenance-api", "start"]

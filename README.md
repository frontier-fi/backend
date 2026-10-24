# Frontier API

GraphQL API for Frontier Finance: pools, tokens, prices and swap routing for the Frontier vault.

It runs at [https://api.frontier.fi/graphql](https://api.frontier.fi/graphql). Opening that URL in a browser shows Apollo Sandbox with an example query and the schema documentation.

## Queries

- Pools: `poolGetPool`, `poolGetPools`, `poolGetPoolsCount`, `poolGetSnapshots`, `poolGetFeaturedPools`, `poolEvents`, `aggregatorPools`
- Tokens: `tokenGetTokens`, `tokenGetTokenDynamicData`, `tokenGetTokensDynamicData`
- Prices: `tokenGetCurrentPrices`, `tokenGetHistoricalPrices`, `tokenGetRelativePriceChartData`
- Protocol: `protocolMetricsChain`, `protocolMetricsAggregated`
- Swaps: `sorGetSwapPaths`

Sepolia is the only configured chain. Addresses can be sent lowercase or EIP-55 checksummed. A mixed-case address with a wrong checksum is rejected with `BAD_USER_INPUT`.

Each operation is limited to depth 15, a cost of 15,000, 15 aliases and 1,000 tokens. Batched requests are not accepted.

## Examples

A pool with its tokens and APRs:

```graphql
{
    poolGetPool(id: "0xd181617f85b6ff1728211c53c0a2b8108bd4a69d", chain: SEPOLIA) {
        id
        name
        type
        poolTokens {
            address
            symbol
            balance
        }
        dynamicData {
            totalLiquidity
            aprItems {
                title
                type
                apr
            }
        }
    }
}
```

Pools with more than $10k of liquidity:

```graphql
{
    poolGetPools(where: { chainIn: [SEPOLIA], minTvl: 10000 }) {
        id
        address
        name
    }
}
```

A quote for swapping 1 WETH to USDC:

```graphql
{
    sorGetSwapPaths(
        chain: SEPOLIA
        swapAmount: "1"
        swapType: EXACT_IN
        tokenIn: "0x7b79995e5f793a07bc00c21412e50ecae098e7f9"
        tokenOut: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"
    ) {
        returnAmount
        paths {
            pools
        }
        priceImpact {
            priceImpact
            error
        }
    }
}
```

## Token prices

A token is only priced once it is in the token list, [frontier-fi/tokenlists](https://github.com/frontier-fi/tokenlists) (`generated/balancer.tokenlist.json`).

Price handlers run in this order, and the first one that can price a token wins:

1. ERC4626: the underlying token's price times the vault's rate
2. CoinGecko, using the token's CoinGecko id
3. BPT: pool liquidity divided by total shares
4. Swaps: inferred from a swap against a token that already has a price
5. Fallback: keeps the last known price

Sepolia tokens are not on CoinGecko under their own address. An override in the token list's `src/tokenlists/balancer/overwrites.ts` can point one at a mainnet id with `extensions: { coingeckoId: 'ethereum' }`, or drop a wrong feed with `coingeckoId: null`.

## Content sources

The token list, the token blocklist, rate-provider and ERC4626 reviews, featured pools, tags and the ERC4626 buffer blocklist come from frontier-fi forks of the Balancer repositories. They are listed in `config/content-sources.ts`.

# Development

## Setup

```sh
bun install
cp .env.example .env
docker compose up -d
bunx prisma migrate deploy --schema prisma/schema
bun run generate
bun run dev
```

`bun run generate` reads the vault and pools subgraph schemas over the network, so it needs internet access.

## Loading data

Background jobs keep the database in sync with the chain and the content sources. To run them locally, start a second process next to the API:

```sh
PORT=4001 WORKER=true SCHEDULER=true WORKER_QUEUE_URL=http://localhost:4001 bun run dev
```

Single jobs can run from the command line instead, for example a full Sepolia sync or a price update:

```sh
bun run task sor-sync-v3 11155111
bun run task update-prices 11155111
```

`bun run task sync-current-prices 11155111` copies current prices from api.frontier.fi into the local database.

Admin mutations need the `AdminApiKey` header:

```sh
curl http://localhost:4000/graphql \
    -H 'Content-Type: application/json' \
    -H "AdminApiKey: $(grep '^ADMIN_API_KEY=' .env | cut -d '=' -f2)" \
    -d '{"query":"mutation { poolSyncAllPoolsFromSubgraph(chain: SEPOLIA) }"}'
```

## Tests

- `bun run test` runs the unit tests.
- `bun run test:e2e` needs `docker compose up -d`. It recreates a `frontier_e2e` database, syncs the live Sepolia pools from the subgraph, and runs the API and a worker against it.

## Database changes

`bunx prisma migrate dev --schema prisma/schema --name <change>` creates a migration in `prisma/schema/migrations`.

# Deployment

Work merges into `staging`. The Release workflow opens a pull request from `staging` to `production`, and the `production` ruleset requires the Checks workflow and one approval before it merges. Merging runs the Deploy workflow:

1. It builds the Docker image once and pushes it to `ghcr.io/frontier-fi/backend`, tagged with the commit. The package is public, so App Platform pulls it without credentials.
2. It applies `.do/prod.yaml` to the `frontier-backend` app on DigitalOcean App Platform with `digitalocean/app_action`, pinned to that image's digest, and waits for the deployment. If the app does not exist yet, the action creates it.
3. It pushes the Stellate configuration, described below.

The spec runs the public `api`, an internal `sor` service for swap quotes, a `worker` that runs the scheduler and the jobs, and a `migrate` job before each deployment, all from that one image. It also sets alerts for failed deployments and domains, and for the CPU, memory and restarts of each component. They email the team's contact address. Every deploy applies the whole file, so settings changed in the dashboard are lost on the next deploy. Change them in the file instead.

The secrets are in the `production` GitHub environment, which only the `production` branch can use. The spec refers to each one by name, as in `'${ADMIN_API_KEY}'`, and the action fills in the values. The workflow stops before deploying if a value the spec uses is missing, since an empty value would replace the live one.

- To add a secret, create it in the environment, reference it in `.do/prod.yaml`, and add it to the `env` of the `deploy` job in `.github/workflows/deploy.yml`.
- To rotate one, update it and re-run the latest Deploy workflow run.
- To roll back, re-run the `deploy` job of an earlier Deploy run, which deploys that run's image and spec.

Before App Platform replaces a container, it sends SIGTERM and allows 120 seconds before killing it. In that time the scheduler stops sending jobs, the worker gives running jobs up to 90 seconds to finish, and the servers close.

Dependabot proposes updates to the pinned GitHub Actions and Docker base images every week. The Bun version CI uses is in `.bun-version`.

## Stellate

Stellate caches responses, rate-limits clients and answers CORS preflights at `https://frontier-api.stellate.sh`. It forwards requests to `https://api-origin.frontier.fi/graphql` with the `x-stellate-origin-secret` header.

`stellate.ts` holds the configuration, and every query needs a cache rule there; a unit test checks that. The Deploy workflow pushes the file after each production deployment, with the `STELLATE_TOKEN` and `STELLATE_ORIGIN_SECRET` secrets of the `production` environment, so changes made in the Stellate dashboard don't last.

`api.frontier.fi` still points straight at the app, and the origin doesn't require the header yet. Moving `api.frontier.fi` onto Stellate needs a paid Stellate plan, for the custom domain. Then, in this order:

1. Add `api.frontier.fi` as the custom domain of the `frontier-api` service.
2. In `.do/prod.yaml`, make `api-origin.frontier.fi` the primary domain, remove `api.frontier.fi`, and deploy. App Platform can't renew the certificate of a domain that resolves elsewhere.
3. Create a CNAME from `api.frontier.fi` to `stellate.map.fastly.net`, and wait until Stellate serves HTTPS on it.
4. Uncomment `STELLATE_ORIGIN_SECRET` on the `api` component in `.do/prod.yaml` and deploy. From then on, the origin only answers requests that came through Stellate, apart from `/health`.

Step 4 must come last: with the secret set while `api.frontier.fi` still points at the app, every public request is rejected.

The `STELLATE_LOGGING_TOKEN` secret lets the `api` component send request metrics and the schema to Stellate, for requests that did not come through the edge.

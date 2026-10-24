import { prisma } from '../../../prisma/prisma-client';
import _ from 'lodash';
import { env } from '../../../apps/env';
import { RateLimiter } from 'limiter';
import config from '../../../config';
import { Chain } from '@prisma/client';

type Price = { usd: number };
interface HistoricalPriceResponse {
    market_caps: number[][];
    prices: number[][];
    total_volumes: number[][];
}

type HistoricalPrice = { timestamp: number; price: number };
export type TokenHistoricalPrices = { [address: string]: HistoricalPrice[] };

interface CoingeckoTokenMarketData {
    id: string;
    symbol: string;
    name: string;
    image: string;
    current_price: number;
    market_cap: number;
    market_cap_rank: number;
    fully_diluted_valuation: number | null;
    total_volume: number;
    high_24h: number;
    low_24h: number;
    price_change_24h: number;
    price_change_percentage_24h: number;
    market_cap_change_24h: number;
    market_cap_change_percentage_24h: number;
    circulating_supply: number;
    total_supply: number;
    max_supply: number | null;
    ath: number;
    ath_change_percentage: number;
    ath_date: Date;
    atl: number;
    atl_change_percentage: number;
    atl_date: Date;
    roi: null;
    last_updated: Date;
    price_change_percentage_14d_in_currency: number;
    price_change_percentage_1h_in_currency: number;
    price_change_percentage_24h_in_currency: number;
    price_change_percentage_30d_in_currency: number;
    price_change_percentage_7d_in_currency: number;
}

interface CoinId {
    id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string>;
}

/* coingecko has a rate limit of 10-50req/minute
   https://www.coingecko.com/en/api/pricing:
   Our free API has a rate limit of 10-50 calls per minute,
   if you exceed that limit you will be blocked until the next 1 minute window.
   Do revise your queries to ensure that you do not exceed our limits should
   that happen.

*/
const tokensPerMinute = env.COINGECKO_API_KEY ? 10 : 3;
const requestRateLimiter = new RateLimiter({ tokensPerInterval: tokensPerMinute, interval: 'minute' });
//max 10 addresses per request because of URI size limit, pro is max 180 because of URI limit
const addressChunkSize = env.COINGECKO_API_KEY ? 180 : 20;
export class CoingeckoDataService {
    private readonly apiKey: string;
    private readonly fiatParam = 'usd';
    /** Demo keys are rejected by pro-api.coingecko.com with error 10011. */
    private useDemoApi = false;

    constructor() {
        this.apiKey = env.COINGECKO_API_KEY ?? '';
    }

    private rootUrl(): string {
        if (this.apiKey && !this.useDemoApi) return 'https://pro-api.coingecko.com/api/v3';
        return 'https://api.coingecko.com/api/v3';
    }

    private authHeaders(): Record<string, string> {
        if (!this.apiKey) return {};
        if (this.useDemoApi) return { 'x-cg-demo-api-key': this.apiKey };
        return { 'x-cg-pro-api-key': this.apiKey };
    }

    public async syncCoingeckoIds() {
        // Q: Do coingecko IDs change?
        const allTokens = await prisma.prismaToken.findMany({
            where: {
                OR: [{ coingeckoTokenId: null }, { coingeckoPlatformId: null }],
                AND: {
                    chain: {
                        not: 'SEPOLIA',
                    },
                },
            },
        });

        // Sepolia is excluded above, and it is the only configured chain. Skip the
        // coin-list request when there is nothing to map.
        if (allTokens.length === 0) {
            return;
        }

        const coinIds = await this.getCoinIdList();
        const platformToChain = Object.fromEntries(
            Object.entries(config)
                .filter(([chain, _]) => chain !== 'SEPOLIA') // Sepolia is not in CG
                .map(([chain, chainConfig]) => [chainConfig.coingecko.platformId, chain]),
        );
        const coinMap = coinIds.reduce(
            (acc, coin) => {
                for (const [platform, address] of Object.entries(coin.platforms)) {
                    if (platformToChain[platform]) {
                        // tokenAddress-chain
                        acc[`${address.toLowerCase()}-${platformToChain[platform]}`] = coin.id;
                    }
                }
                return acc;
            },
            {} as Record<string, string>,
        );

        const updates = allTokens
            .map((token) => {
                const coingeckoTokenId = coinMap[`${token.address}-${token.chain}`];
                const coingeckoPlatformId = config[token.chain].coingecko.platformId;

                if (token.coingeckoTokenId !== coingeckoTokenId || token.coingeckoPlatformId !== coingeckoPlatformId) {
                    return prisma.prismaToken.update({
                        where: {
                            address_chain: { address: token.address, chain: token.chain },
                        },
                        data: {
                            coingeckoTokenId,
                            coingeckoPlatformId,
                        },
                    });
                }
            })
            .filter((update): update is NonNullable<typeof update> => !!update);

        await prisma.$transaction(updates);
    }

    async tokenPrice(chain: Chain, tokens: string[]) {
        const platformId = config[chain].coingecko.platformId;
        const endpoint = `/simple/token_price/${platformId}?vs_currencies=usd&contract_addresses=${tokens.join(',')}`;

        return this.get<{ [token: string]: { usd: number } }>(endpoint);
    }

    public async getMarketDataForTokenIds(tokenIds: string[]): Promise<CoingeckoTokenMarketData[]> {
        const endpoint = `/coins/markets?vs_currency=${this.fiatParam}&ids=${tokenIds}&per_page=250&page=1&sparkline=false&price_change_percentage=1h%2C24h%2C7d%2C14d%2C30d`;

        return this.get<CoingeckoTokenMarketData[]>(endpoint);
    }

    private async getCoinIdList(): Promise<CoinId[]> {
        const endpoint = `/coins/list?include_platform=true`;
        return this.get<CoinId[]>(endpoint);
    }

    private async get<T>(endpoint: string): Promise<T> {
        const remainingRequests = await requestRateLimiter.removeTokens(1);
        console.log('Remaining coingecko requests', remainingRequests);

        const response = await fetch(this.rootUrl() + endpoint, { headers: this.authHeaders() });

        if (!response.ok) {
            const body = await response.text();
            if (!this.useDemoApi && body.includes('"error_code":10011')) {
                this.useDemoApi = true;
                return this.get(endpoint);
            }
            if (response.status === 429) {
                throw Error(`Coingecko ratelimit: ${response.status} ${response.statusText}`);
            }
            throw Error(`Coingecko API error: ${response.status} ${response.statusText}`);
        }

        return (await response.json()) as T;
    }
}

export const coingeckoDataService = new CoingeckoDataService();

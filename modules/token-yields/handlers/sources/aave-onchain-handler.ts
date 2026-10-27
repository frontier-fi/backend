import { TokenApr, TokenYieldHandler, AaveAddressBookEntry } from '../../types';
import aaveUiPoolDataProvider, { aaveUiPoolDataProviderLegacy } from './abis/aave-ui-pool-data-provider';
import { getViemClient } from '../../../sources/viem-client';
import { chainIdToChain } from '../../../../config/chain-id-to-chain';

const fetchReservesList = async (client: ReturnType<typeof getViemClient>, market: AaveAddressBookEntry) => {
    try {
        return await client.readContract({
            address: market.UI_POOL_DATA_PROVIDER,
            abi: aaveUiPoolDataProvider,
            functionName: 'getReservesData',
            args: [market.POOL_ADDRESSES_PROVIDER],
        });
    } catch {
        return await client.readContract({
            address: market.UI_POOL_DATA_PROVIDER,
            abi: aaveUiPoolDataProviderLegacy,
            functionName: 'getReservesData',
            args: [market.POOL_ADDRESSES_PROVIDER],
        });
    }
};

export const aaveOnchainHandler: TokenYieldHandler = async ({ markets }: { markets: AaveAddressBookEntry[] }) => {
    const tokenAprs: TokenApr[] = [];

    try {
        for (const market of markets) {
            const chain = chainIdToChain[market.CHAIN_ID];

            if (!chain || !market || !market?.ASSETS) {
                continue;
            }

            const tokens = await getTokenMappings(Object.values(market.ASSETS));

            const client = getViemClient(chain);

            const list = await fetchReservesList(client, market);
            const liquidityRates = new Map(
                list[0].map((item) => [
                    item.underlyingAsset.toLowerCase(),
                    Number(item.liquidityRate) / 1e27,
                ]),
            );

            tokenAprs.push(
                ...tokens
                    .flatMap((token) => {
                        const apr = liquidityRates.get(token.underlyingAsset);

                        if (!apr) return;

                        return token.wrappers.map((wrapper) => ({
                            address: wrapper,
                            apr,
                        }));
                    })
                    .filter((v) => !!v),
            );
        }
    } catch (e) {
        throw Error(`Failed to fetch Aave onchain APR: ${(e as Error).message}`);
    }

    return tokenAprs;
};

const getTokenMappings = async (assets?: any[]) => {
    if (!assets || assets.length === 0) return [];

    const mappings = Object.values(assets)
        .map((asset) => ({
            aToken: asset.A_TOKEN.toLowerCase(),
            underlyingAsset: asset.UNDERLYING.toLowerCase(),
            wrappers: [asset.STATIC_A_TOKEN?.toLowerCase(), asset.STATA_TOKEN?.toLowerCase()].filter((w) => !!w),
        }))
        .filter((w) => w.wrappers.length > 0);

    return mappings;
};

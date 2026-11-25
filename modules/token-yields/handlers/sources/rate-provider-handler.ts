import { TokenYieldHandler, RateProviderYieldConfig } from '../../types';
import { getViemClient } from '../../../sources/viem-client';
import { formatEther, parseAbiItem, Hex } from 'viem';
import { blockNumbers } from '../../../block-numbers';
import { daysAgo, now } from '../../../common/time';

const abi = [parseAbiItem('function getRate() view returns(uint)')];

const relativeGrowth = (currentRate: bigint, pastRate: bigint) =>
    parseFloat(formatEther(currentRate)) / parseFloat(formatEther(pastRate)) - 1;

export const rateProviderHandler: TokenYieldHandler = async ({
    chain,
    intervalInDays,
    rateProviders,
}: RateProviderYieldConfig) => {
    try {
        const client = getViemClient(chain, { multicallBatch: true, jsonRpcBatch: true });

        const pastBlock = await blockNumbers().getBlock(chain, daysAgo(intervalInDays));
        const fallbackIntervalBlock = await blockNumbers().getBlock(chain, now() - 24 * 3600);

        if (!pastBlock) {
            return [];
        }

        const aprs = await Promise.allSettled(
            rateProviders.map(async ({ tokenAddress, rateProviderAddress }) => {
                const currentRate = await client.readContract({
                    address: rateProviderAddress as Hex,
                    abi,
                    functionName: 'getRate',
                });

                let pastRate: bigint;
                let apr: number;
                try {
                    pastRate = await client.readContract({
                        address: rateProviderAddress as Hex,
                        abi,
                        functionName: 'getRate',
                        blockNumber: BigInt(pastBlock),
                    });

                    apr = relativeGrowth(currentRate, pastRate) * (365 / intervalInDays);
                } catch {
                    // When contract doesn't exit it fails with
                    // The contract function "getRate" returned no data ("0x")
                    if (!fallbackIntervalBlock) return;

                    pastRate = await client.readContract({
                        address: rateProviderAddress as Hex,
                        abi,
                        functionName: 'getRate',
                        blockNumber: BigInt(fallbackIntervalBlock),
                    });

                    apr = relativeGrowth(currentRate, pastRate) * 365;
                }

                return {
                    address: tokenAddress,
                    apr,
                };
            }),
        ).then((results) =>
            results
                .filter((r) => r.status === 'fulfilled')
                .map((r) => r.value)
                .filter((v) => !!v)
                .filter((v) => v.apr > 0),
        );

        return aprs;
    } catch (error) {
        throw Error(`Rate provider APR hanlder failed: ${(error as Error).message}`);
    }
};

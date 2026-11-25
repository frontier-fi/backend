import { TokenYieldHandler, RateProviderYieldConfig } from '../../types';
import { getViemClient } from '../../../sources/viem-client';
import { BaseError, ContractFunctionZeroDataError, formatEther, parseAbiItem, Hex } from 'viem';
import { logger } from '../../../common/logger';
import { secondsPerDay, secondsPerYear } from '../../../common/time';

const abi = [parseAbiItem('function getRate() view returns(uint)')];

// Number of recent blocks used to measure the chain's average block time
const BLOCK_TIME_SAMPLE = 10_000;

const relativeGrowth = (currentRate: bigint, pastRate: bigint) =>
    parseFloat(formatEther(currentRate)) / parseFloat(formatEther(pastRate)) - 1;

export const rateProviderHandler: TokenYieldHandler = async ({
    chain,
    intervalInDays,
    rateProviders,
}: RateProviderYieldConfig) => {
    try {
        const client = getViemClient(chain, { multicallBatch: true, jsonRpcBatch: true });

        const latest = await client.getBlock();
        const sample = await client.getBlock({ blockNumber: latest.number - BigInt(BLOCK_TIME_SAMPLE) });
        const blockTime = Number(latest.timestamp - sample.timestamp) / BLOCK_TIME_SAMPLE;

        // Located from the average block time, so the block is only roughly `days` old.
        // The APR is annualised over the time that really elapsed since its timestamp.
        const blockDaysAgo = (days: number) =>
            client.getBlock({ blockNumber: latest.number - BigInt(Math.round((days * secondsPerDay) / blockTime)) });

        const [pastBlock, fallbackBlock] = await Promise.all([blockDaysAgo(intervalInDays), blockDaysAgo(1)]);

        const getRate = (address: string, blockNumber: bigint) =>
            client.readContract({ address: address as Hex, abi, functionName: 'getRate', blockNumber });

        const results = await Promise.allSettled(
            rateProviders.map(async ({ tokenAddress, rateProviderAddress }) => {
                const currentRate = await getRate(rateProviderAddress, latest.number);

                // Rate providers that weren't live for the whole interval get the 1 day window
                for (const block of [pastBlock, fallbackBlock]) {
                    const pastRate = await getRate(rateProviderAddress, block.number).catch((error) => {
                        // No data means the rate provider wasn't deployed yet. Anything else is an RPC failure,
                        // like missing historical state, and must not be mistaken for a young rate provider.
                        if (
                            error instanceof BaseError &&
                            error.walk((e) => e instanceof ContractFunctionZeroDataError)
                        ) {
                            return 0n;
                        }
                        throw error;
                    });
                    if (pastRate === 0n) continue;

                    const years = Number(latest.timestamp - block.timestamp) / secondsPerYear;
                    // A rate that fell is a loss and not a yield, so it is stored as 0
                    return { address: tokenAddress, apr: Math.max(relativeGrowth(currentRate, pastRate) / years, 0) };
                }
            }),
        );

        const failures = results.flatMap((result, i) =>
            result.status === 'rejected' ? [{ tokenAddress: rateProviders[i].tokenAddress, err: result.reason }] : [],
        );
        if (failures.length > 0) {
            const { err } = failures[0];
            // These tokens keep their previous APR. Logged at error level, which is what the alerts count,
            // and once per run so that a single failed run doesn't look like a burst of errors.
            logger.error('Rate provider APR failed', {
                chain,
                tokenAddresses: failures.map((failure) => failure.tokenAddress),
                // viem's full message puts the RPC's own reason after the calldata, beyond the logger's length cap
                err: err instanceof BaseError ? err.details || err.shortMessage : err,
            });
        }

        return results.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
    } catch (error) {
        throw Error(`Rate provider APR handler failed: ${(error as Error).message}`);
    }
};

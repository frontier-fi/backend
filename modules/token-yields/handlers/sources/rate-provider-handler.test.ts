import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionExecutionError, ContractFunctionZeroDataError, parseEther } from 'viem';
import { logger } from '../../../common/logger';
import { rateProviderHandler } from './rate-provider-handler';

const DAY = 86400;
const LATEST = { number: 10_000_000n, timestamp: 1_800_000_000n };
// The mocked chain produces one block per second
const BLOCK_7D = LATEST.number - BigInt(7 * DAY);
const BLOCK_1D = LATEST.number - BigInt(DAY);

const notDeployed = new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: 'getRate' }), {
    abi: [],
    functionName: 'getRate',
});

let timestamps: Record<string, bigint>;
let rates: Record<string, Record<string, bigint | Error>>;

vi.mock('../../../sources/viem-client', () => ({
    getViemClient: () => ({
        getBlock: async ({ blockNumber = LATEST.number } = {}) => ({
            number: blockNumber,
            timestamp: timestamps[String(blockNumber)] ?? LATEST.timestamp - (LATEST.number - blockNumber),
        }),
        readContract: async ({ address, blockNumber }: { address: string; blockNumber: bigint }) => {
            const rate = rates[address][String(blockNumber)];
            if (rate instanceof Error) throw rate;
            return rate;
        },
    }),
}));

const handle = (tokens: string[]) =>
    rateProviderHandler({
        chain: 'MONAD',
        intervalInDays: 7,
        rateProviders: tokens.map((token) => ({ tokenAddress: token, rateProviderAddress: token })),
    });

describe('rateProviderHandler', () => {
    beforeEach(() => {
        timestamps = {};
        rates = {};
    });

    it('annualises rate growth over the time that really elapsed', async () => {
        // The chain was slower earlier on, so the block located for 7 days ago is really 10 days old
        timestamps[String(BLOCK_7D)] = LATEST.timestamp - BigInt(10 * DAY);
        rates.a = { [String(LATEST.number)]: parseEther('1.111'), [String(BLOCK_7D)]: parseEther('1.1') };

        const [{ address, apr }] = await handle(['a']);

        expect(address).toBe('a');
        expect(apr).toBeCloseTo((0.01 * 365) / 10, 10);
    });

    it('uses the 1 day window for rate providers that were not live for the whole interval', async () => {
        rates.notDeployed = {
            [String(LATEST.number)]: parseEther('1.001'),
            [String(BLOCK_7D)]: notDeployed,
            [String(BLOCK_1D)]: parseEther('1'),
        };
        rates.zeroRate = { ...rates.notDeployed, [String(BLOCK_7D)]: 0n };

        const aprs = await handle(['notDeployed', 'zeroRate']);

        expect(aprs.map((a) => a.address)).toEqual(['notDeployed', 'zeroRate']);
        expect(aprs[0].apr).toBeCloseTo(0.001 * 365, 10);
        expect(aprs[1].apr).toBeCloseTo(0.001 * 365, 10);
    });

    it('skips rate providers that were not live in either window', async () => {
        rates.a = {
            [String(LATEST.number)]: parseEther('1'),
            [String(BLOCK_7D)]: notDeployed,
            [String(BLOCK_1D)]: notDeployed,
        };

        expect(await handle(['a'])).toEqual([]);
    });

    it('does not fall back to the 1 day window when the RPC fails, and reports it', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const rpcError = new Error('Block requested not found');
        rates.failing = {
            [String(LATEST.number)]: parseEther('1.07'),
            [String(BLOCK_7D)]: rpcError,
            [String(BLOCK_1D)]: parseEther('1'),
        };
        rates.healthy = { [String(LATEST.number)]: parseEther('1.07'), [String(BLOCK_7D)]: parseEther('1') };

        const aprs = await handle(['failing', 'healthy']);

        expect(aprs.map((a) => a.address)).toEqual(['healthy']);
        expect(aprs[0].apr).toBeCloseTo(0.07 * (365 / 7), 10);
        expect(warn).toHaveBeenCalledWith('Rate provider APR failed', {
            chain: 'MONAD',
            tokenAddress: 'failing',
            err: rpcError,
        });
    });

    it('stores 0 for flat and falling rates', async () => {
        rates.flat = { [String(LATEST.number)]: parseEther('1.2'), [String(BLOCK_7D)]: parseEther('1.2') };
        rates.falling = { [String(LATEST.number)]: parseEther('1.1'), [String(BLOCK_7D)]: parseEther('1.2') };

        expect(await handle(['flat', 'falling'])).toEqual([
            { address: 'flat', apr: 0 },
            { address: 'falling', apr: 0 },
        ]);
    });
});

import { Chain, PrismaToken } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../../../../config';
import { fetchMaxValues } from './fetch-erc4626-max-values';

const { multicall } = vi.hoisted(() => ({ multicall: vi.fn() }));

vi.mock('../../../sources/viem-client', () => ({
    getViemClient: () => ({
        chain: { id: 11155111 },
        multicall,
    }),
}));

const VAULT = config.SEPOLIA.contracts.Vault;
const USDC_WRAPPER = '0x1111111111111111111111111111111111111111';
const WETH_WRAPPER = '0x2222222222222222222222222222222222222222';

const ok = (result: bigint) => ({ status: 'success' as const, result });
const failed = { status: 'failure' as const, error: new Error('revert') };

function token(address: string, decimals: number): PrismaToken {
    return { address, decimals } as PrismaToken;
}

describe('fetchMaxValues', () => {
    beforeEach(() => {
        multicall.mockReset();
    });

    it('returns an empty map when there are no tokens', async () => {
        await expect(fetchMaxValues(Chain.SEPOLIA, [])).resolves.toEqual({});
        expect(multicall).not.toHaveBeenCalled();
    });

    it('formats maxDeposit and maxWithdraw for each wrapper, using the vault as the receiver', async () => {
        multicall.mockResolvedValue([ok(1_500_000n), ok(2_500_000n), ok(3n * 10n ** 18n), ok(4n * 10n ** 18n)]);

        const values = await fetchMaxValues(Chain.SEPOLIA, [token(USDC_WRAPPER, 6), token(WETH_WRAPPER, 18)]);

        expect(values).toEqual({
            [USDC_WRAPPER]: { maxDeposit: '1.5', maxWithdraw: '2.5' },
            [WETH_WRAPPER]: { maxDeposit: '3', maxWithdraw: '4' },
        });

        const contracts = multicall.mock.calls[0][0].contracts as {
            address: string;
            functionName: string;
            args: string[];
        }[];
        expect(contracts.map((call) => [call.address, call.functionName, call.args[0]])).toEqual([
            [USDC_WRAPPER, 'maxDeposit', VAULT],
            [USDC_WRAPPER, 'maxWithdraw', VAULT],
            [WETH_WRAPPER, 'maxDeposit', VAULT],
            [WETH_WRAPPER, 'maxWithdraw', VAULT],
        ]);
        expect(multicall.mock.calls[0][0].multicallAddress).toBe(config.SEPOLIA.multicall3);
    });

    it('keeps a zero for a call that reverted and skips a token whose calls both failed', async () => {
        multicall.mockResolvedValue([ok(1_000_000n), failed, failed, failed]);

        const values = await fetchMaxValues(Chain.SEPOLIA, [token(USDC_WRAPPER, 6), token(WETH_WRAPPER, 18)]);

        expect(values).toEqual({
            [USDC_WRAPPER]: { maxDeposit: '1', maxWithdraw: '0' },
        });
    });

    it('uses underlying token decimals when underlyingTokenMap is provided', async () => {
        multicall.mockResolvedValue([ok(5_000_000n), ok(6_000_000n)]);
        const underlyingAddress = '0x3333333333333333333333333333333333333333';
        const wrapperWith18Decimals = {
            address: USDC_WRAPPER,
            decimals: 18,
            underlyingTokenAddress: underlyingAddress,
        } as PrismaToken;

        const values = await fetchMaxValues(Chain.SEPOLIA, [wrapperWith18Decimals], {
            [underlyingAddress]: token(underlyingAddress, 6),
        });

        expect(values).toEqual({
            [USDC_WRAPPER]: { maxDeposit: '5', maxWithdraw: '6' },
        });
    });
});

import { Chain } from '@prisma/client';
import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { V3JoinedSubgraphPool } from '../subgraphs';
import { hookTransformer } from './hook-transformer';

const knownHook = '0xbb1761af481364a6bd7fdbdb8cfa23abd85f0263';

const pool = (address: string) =>
    ({
        hookConfig: {
            hook: { address },
            enableHookAdjustedAmounts: false,
            shouldCallAfterSwap: false,
            shouldCallBeforeSwap: true,
            shouldCallAfterInitialize: false,
            shouldCallBeforeInitialize: false,
            shouldCallAfterAddLiquidity: false,
            shouldCallBeforeAddLiquidity: false,
            shouldCallAfterRemoveLiquidity: false,
            shouldCallBeforeRemoveLiquidity: false,
            shouldCallComputeDynamicSwapFee: false,
        },
    }) as unknown as V3JoinedSubgraphPool;

describe('hookTransformer', () => {
    it('ignores the zero address', () => {
        expect(hookTransformer(pool(zeroAddress), Chain.SEPOLIA)).toBeUndefined();
    });

    it('maps a known Sepolia hook address', () => {
        expect(hookTransformer(pool(knownHook), Chain.SEPOLIA)?.type).toBe('FEE_TAKING');
    });

    it('marks an unknown hook address as UNKNOWN', () => {
        const hook = hookTransformer(pool('0x1111111111111111111111111111111111111111'), Chain.SEPOLIA);
        expect(hook?.type).toBe('UNKNOWN');
        expect(hook?.address).toBe('0x1111111111111111111111111111111111111111');
    });
});

import { Chain } from '@prisma/client';
import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { V3JoinedSubgraphPool } from '../subgraphs';
import { hookTransformer, mapHookToGqlHook } from './hook-transformer';
import { HookData } from '../../../prisma/prisma-types';

const pool = (address: string) =>
    ({
        hookConfig: {
            hook: { address },
            enableHookAdjustedAmounts: true,
            shouldCallAfterSwap: false,
            shouldCallBeforeSwap: true,
            shouldCallAfterInitialize: false,
            shouldCallBeforeInitialize: false,
            shouldCallAfterAddLiquidity: false,
            shouldCallBeforeAddLiquidity: false,
            shouldCallAfterRemoveLiquidity: false,
            shouldCallBeforeRemoveLiquidity: false,
            shouldCallComputeDynamicSwapFee: true,
        },
    }) as unknown as V3JoinedSubgraphPool;

describe('hookTransformer', () => {
    it('ignores the zero address', () => {
        expect(hookTransformer(pool(zeroAddress), Chain.SEPOLIA)).toBeUndefined();
    });

    it('stores any other address as UNKNOWN and keeps the vault flags', () => {
        const hook = hookTransformer(pool('0xBB1761AF481364A6BD7FDBDB8CFA23ABD85F0263'), Chain.SEPOLIA);

        expect(hook).toMatchObject({
            address: '0xbb1761af481364a6bd7fdbdb8cfa23abd85f0263',
            type: 'UNKNOWN',
            enableHookAdjustedAmounts: true,
            shouldCallBeforeSwap: true,
            shouldCallComputeDynamicSwapFee: true,
        });
    });
});

describe('mapHookToGqlHook', () => {
    const hook: HookData = {
        address: '0x1111111111111111111111111111111111111111',
        type: 'UNKNOWN',
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
    };

    it('returns nothing when the hook has no type', () => {
        expect(mapHookToGqlHook({ ...hook, type: undefined as unknown as HookData['type'] })).toBeUndefined();
    });

    it('exposes the address, type, and vault config', () => {
        expect(mapHookToGqlHook(hook)).toEqual({
            address: hook.address,
            type: 'UNKNOWN',
            config: {
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
        });
    });
});

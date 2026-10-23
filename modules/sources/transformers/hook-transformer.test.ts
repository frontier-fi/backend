import { Chain } from '@prisma/client';
import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { V3JoinedSubgraphPool } from '../subgraphs';
import { hookTransformer, mapHookToGqlHook } from './hook-transformer';
import { HookData } from '../../../prisma/prisma-types';

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

    it('maps every configured Sepolia hook', () => {
        const expected: Record<string, string> = {
            '0x2d8d157fd6cf773624d97808d77081ee45caa7d4': 'LOTTERY',
            '0x3c194f14527b4e02b0d09274eca72ccb67613fac': 'LOTTERY',
            '0xbb1761af481364a6bd7fdbdb8cfa23abd85f0263': 'FEE_TAKING',
            '0xea672a54f0aa38fc5f0a1a481467bebfe3c71046': 'EXIT_FEE',
            '0x1adc55adb4caae71abb4c33f606493f4114d2091': 'STABLE_SURGE',
            '0xc0cbcdd6b823a4f22aa6bbdde44c17e754266aef': 'STABLE_SURGE',
            '0x30ce53fa38a1399f0ca158b5c38362c80e423ba9': 'STABLE_SURGE',
            '0xd68372e85d8a14afa5fdb3d506bf765939aaf382': 'DIRECTIONAL_FEE',
            '0xd06dd26c7209cfe0752725f068299be69a7c9549': 'NFTLIQUIDITY_POSITION',
            '0x18b10fe9ec4815c31c4ab04fa6f91dce0695132f': 'MEV_TAX',
            '0xec9578e79d412537095501584284b092d2f6b9f7': 'MEV_TAX',
        };

        for (const [address, type] of Object.entries(expected)) {
            expect(hookTransformer(pool(address), Chain.SEPOLIA)?.type).toBe(type);
        }
    });
});

describe('mapHookToGqlHook', () => {
    const flags = {
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
    };

    function hook(type: HookData['type'], dynamicData?: Record<string, string>): HookData {
        return { address: knownHook, type, ...flags, dynamicData };
    }

    it('returns nothing when the hook has no type', () => {
        expect(mapHookToGqlHook({ ...hook('FEE_TAKING'), type: undefined as unknown as HookData['type'] })).toBeUndefined();
    });

    it('attaches typed params for fee, exit, and surge hooks', () => {
        expect(mapHookToGqlHook(hook('FEE_TAKING', { takeFeePercentage: '0.1' }))?.params).toMatchObject({
            __typename: 'FeeTakingHookParams',
            takeFeePercentage: '0.1',
        });
        expect(mapHookToGqlHook(hook('EXIT_FEE', { removeLiquidityFeePercentage: '0.01' }))?.params).toMatchObject({
            __typename: 'ExitFeeHookParams',
        });
        expect(mapHookToGqlHook(hook('STABLE_SURGE', { surgeThresholdPercentage: '0.3' }))?.params).toMatchObject({
            __typename: 'StableSurgeHookParams',
            surgeThresholdPercentage: '0.3',
        });
        expect(mapHookToGqlHook(hook('MEV_TAX'))?.params).toMatchObject({ __typename: 'MevTaxHookParams' });
    });

    it('leaves params empty for hooks that only carry flags', () => {
        for (const type of ['DIRECTIONAL_FEE', 'LOTTERY', 'NFTLIQUIDITY_POSITION', 'UNKNOWN'] as const) {
            const mapped = mapHookToGqlHook(hook(type));
            expect(mapped?.params).toBeUndefined();
            expect(mapped?.type).toBe(type);
            expect(mapped?.config?.shouldCallBeforeSwap).toBe(true);
            expect(mapped?.config?.shouldCallComputeDynamicSwapFee).toBe(true);
        }
    });
});

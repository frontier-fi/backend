import { getHookState, isLiquidityManagement } from './helpers';
import { PrismaPoolAndHookWithDynamic, HookData } from '../../../../prisma/prisma-types';
import { parseEther, parseUnits } from 'viem';

describe('getHookState', () => {
    it('should return undefined if pool has no hook', () => {
        const pool = { hook: null } as unknown as PrismaPoolAndHookWithDynamic;
        expect(getHookState(pool)).toBeUndefined();
    });

    it('should return undefined for MEV_TAX hook type', () => {
        const pool = {
            hook: { type: 'MEV_TAX' } as unknown as HookData,
        } as unknown as PrismaPoolAndHookWithDynamic;
        expect(getHookState(pool)).toBeUndefined();
    });

    it('should return correct hook state for EXIT_FEE hook type', () => {
        const removeLiquidityFeePercentage = '0.01';
        const tokens = [{ address: '0x1234' }, { address: '0x5678' }];
        const pool = {
            tokens,
            hook: {
                type: 'EXIT_FEE',
                dynamicData: { removeLiquidityFeePercentage },
            } as unknown as HookData,
        } as unknown as PrismaPoolAndHookWithDynamic;

        const expectedHookState = {
            tokens: tokens.map((token) => token.address),
            removeLiquidityHookFeePercentage: parseEther(removeLiquidityFeePercentage),
            hookType: 'ExitFee',
        };

        expect(getHookState(pool)).toEqual(expectedHookState);
    });

    it('should return correct hook state for DIRECTIONAL_FEE hook type', () => {
        const pool = {
            hook: { type: 'DIRECTIONAL_FEE' } as unknown as HookData,
        } as unknown as PrismaPoolAndHookWithDynamic;

        const expectedHookState = {
            hookType: 'DirectionalFee',
        };

        expect(getHookState(pool)).toEqual(expectedHookState);
    });

    it('should return correct hook state for STABLE_SURGE hook type', () => {
        const amp = '200';
        const surgeThresholdPercentage = '0.02';
        const maxSurgeFeePercentage = '0.05';

        const pool = {
            typeData: { amp },
            hook: {
                type: 'STABLE_SURGE',
                dynamicData: {
                    surgeThresholdPercentage,
                    maxSurgeFeePercentage,
                },
            } as unknown as HookData,
        } as unknown as PrismaPoolAndHookWithDynamic;

        const expectedHookState = {
            amp: parseUnits(amp, 3),
            surgeThresholdPercentage: parseEther(surgeThresholdPercentage),
            maxSurgeFeePercentage: parseEther(maxSurgeFeePercentage),
            hookType: 'StableSurge',
        };

        expect(getHookState(pool)).toEqual(expectedHookState);
    });

    it('should return undefined for unknown hook type', () => {
        const pool = {
            id: 'test-pool',
            hook: { type: 'UNKNOWN_HOOK_TYPE' } as unknown as HookData,
        } as unknown as PrismaPoolAndHookWithDynamic;

        expect(getHookState(pool)).toBeUndefined();
    });

    it('should return undefined for hook with no type', () => {
        const pool = {
            hook: {} as unknown as HookData,
        } as unknown as PrismaPoolAndHookWithDynamic;

        expect(getHookState(pool)).toBeUndefined();
    });

    it('returns undefined for a hook type the router does not model', () => {
        const pool = {
            id: 'lottery-pool',
            hook: { type: 'LOTTERY' } as unknown as HookData,
        } as unknown as PrismaPoolAndHookWithDynamic;

        expect(getHookState(pool)).toBeUndefined();
    });
});

describe('isLiquidityManagement', () => {
    const flags = {
        disableUnbalancedLiquidity: false,
        enableAddLiquidityCustom: false,
        enableDonation: true,
        enableRemoveLiquidityCustom: false,
    };

    it('accepts the four vault flags', () => {
        expect(isLiquidityManagement(flags)).toBe(true);
    });

    it('rejects a partial or empty value', () => {
        expect(isLiquidityManagement(null)).toBeFalsy();
        expect(isLiquidityManagement({ disableUnbalancedLiquidity: true })).toBe(false);
        expect(isLiquidityManagement({ ...flags, enableDonation: 'yes' })).toBe(false);
    });
});

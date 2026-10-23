import { getHookState, isLiquidityManagement } from './helpers';
import { PrismaPoolAndHookWithDynamic, HookData } from '../../../../prisma/prisma-types';

describe('getHookState', () => {
    it('returns undefined when the pool has no hook', () => {
        const pool = { hook: null } as unknown as PrismaPoolAndHookWithDynamic;
        expect(getHookState(pool)).toBeUndefined();
    });

    it('returns undefined for a stored hook until a type implements quote math', () => {
        const pool = {
            id: 'pool',
            hook: { type: 'UNKNOWN' } as unknown as HookData,
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

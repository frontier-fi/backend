import { Factory } from 'fishery';
import { createRandomAddress } from '../utils';

import { HookData } from '../../prisma/prisma-types';

class PrismaHookFactory extends Factory<HookData> {}

export const hookFactory = PrismaHookFactory.define(() => {
    return {
        address: createRandomAddress(),
        type: 'UNKNOWN',
        enableHookAdjustedAmounts: false,
        shouldCallAfterSwap: false,
        shouldCallBeforeSwap: false,
        shouldCallAfterInitialize: false,
        shouldCallBeforeInitialize: false,
        shouldCallAfterAddLiquidity: false,
        shouldCallBeforeAddLiquidity: false,
        shouldCallAfterRemoveLiquidity: false,
        shouldCallBeforeRemoveLiquidity: false,
        shouldCallComputeDynamicSwapFee: false,
    } as HookData;
});

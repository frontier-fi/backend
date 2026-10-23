import { Chain } from '@prisma/client';
import { HookData } from '../../../prisma/prisma-types';
import { GqlHook } from '../../../apps/api/gql/generated-schema';
import { V3JoinedSubgraphPool } from '../subgraphs';
import { zeroAddress } from 'viem';
import config from '../../../config';
import { addressesMatch, normalizeAddress } from '../../web3/addresses';

export const hookTransformer = (poolData: V3JoinedSubgraphPool, chain: Chain): HookData | undefined => {
    // A v3 pool with no hook still carries a hook config whose address is 0x0.
    const hookConfig =
        poolData.hookConfig && !addressesMatch(poolData.hookConfig.hook.address, zeroAddress)
            ? poolData.hookConfig
            : undefined;

    if (!hookConfig) {
        return undefined;
    }

    const { hook, ...hookFlags } = hookConfig;
    const registered = Object.entries(config[chain].hooks ?? {}).find(([address]) =>
        addressesMatch(address, hook.address),
    );
    const type = registered?.[1] ?? 'UNKNOWN';

    return {
        address: normalizeAddress(hook.address),
        type,
        ...hookFlags,
    };
};

export const mapHookToGqlHook = (hookData: HookData): GqlHook | undefined => {
    if (!hookData?.type) {
        return undefined;
    }

    return {
        address: hookData.address,
        type: hookData.type,
        config: {
            enableHookAdjustedAmounts: hookData.enableHookAdjustedAmounts,
            shouldCallAfterSwap: hookData.shouldCallAfterSwap,
            shouldCallBeforeSwap: hookData.shouldCallBeforeSwap,
            shouldCallAfterInitialize: hookData.shouldCallAfterInitialize,
            shouldCallBeforeInitialize: hookData.shouldCallBeforeInitialize,
            shouldCallAfterAddLiquidity: hookData.shouldCallAfterAddLiquidity,
            shouldCallBeforeAddLiquidity: hookData.shouldCallBeforeAddLiquidity,
            shouldCallAfterRemoveLiquidity: hookData.shouldCallAfterRemoveLiquidity,
            shouldCallBeforeRemoveLiquidity: hookData.shouldCallBeforeRemoveLiquidity,
            shouldCallComputeDynamicSwapFee: hookData.shouldCallComputeDynamicSwapFee,
        },
    };
};

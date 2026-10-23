import type { ViemMulticallCall } from '../../../web3/multicaller-viem';
import { multicallViem } from '../../../web3/multicaller-viem';
import { ViemClient } from '../../types';
import { HookData } from '../../../../prisma/prisma-types';

// Register a hook type's multicall here when Frontier adds one.
export const hookCallsMap: Partial<
    Record<HookData['type'], (address: string, poolAddress: string) => ViemMulticallCall[]>
> = {};

export const hookDataCalls = (pool: { id: string; hook?: HookData }) => {
    if (!pool.hook) {
        return [];
    }

    const callsFn = hookCallsMap[pool.hook.type];
    return callsFn ? callsFn(pool.hook.address, pool.id) : [];
};

export const fetchHookData = async (
    client: ViemClient,
    pools: {
        id: string;
        hook: HookData;
    }[],
    blockNumber?: bigint,
): Promise<{ [poolAddress: string]: Record<string, string> }> => {
    if (pools.length === 0) {
        return {};
    }

    const calls = pools.flatMap((pool) => hookDataCalls(pool));
    if (calls.length === 0) {
        return {};
    }

    const results = await multicallViem<Record<string, { pool: { hook: { dynamicData: Record<string, string> } } }>>(
        client,
        calls,
        blockNumber,
    );

    return Object.fromEntries(
        Object.entries(results).map(([poolAddress, result]) => {
            return [poolAddress, result.pool.hook.dynamicData];
        }),
    );
};

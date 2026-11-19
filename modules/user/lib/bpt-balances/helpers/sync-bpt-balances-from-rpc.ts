import { Chain, PrismaLastBlockSyncedCategory } from '@prisma/client';
import { ViemClient } from '../../../../sources/types';
import { prisma } from '../../../../../prisma/prisma-client';
import config from '../../../../../config';
import { getEvents } from '../../../../web3/events';
import _ from 'lodash';
import ERC20Abi from '../../../../web3/abi/ERC20';
import { formatEther, parseAbi, zeroAddress } from 'viem';
import { multicallViem } from '../../../../web3/multicaller-viem';
import { balancesToDb } from './balances-to-db';
import { getLastSyncedBlock } from '../../../../actions/last-synced-block';
import { logger } from '../../../../common/logger';

const rpcMaxBlockRange = (chain: Chain) => config[chain].rpcMaxBlockRange;

export const syncBptBalancesFromRpc = async (
    poolIds: string[],
    client: ViemClient,
    chain: Chain,
    syncCategory?: PrismaLastBlockSyncedCategory,
    fromBlockOverride?: number,
) => {
    // Must have poolIds to sync
    if (poolIds.length === 0) {
        return 0;
    }

    const toBlock = await client.getBlockNumber().then(Number);

    let startBlock: number;
    let fromBlock: number;
    if (fromBlockOverride !== undefined) {
        startBlock = Math.max(1, fromBlockOverride);
        fromBlock = startBlock;
    } else if (syncCategory) {
        startBlock = await getLastSyncedBlock(chain, syncCategory);

        // Don't use RPC when balances weren't synced at all
        if (startBlock === 1) {
            return 0;
        }

        fromBlock = startBlock - 5; // Using just 5 blocks here, because we rely on the subgraph 1st
    } else {
        return 0;
    }

    // no new blocks have been minted, needed for slow networks
    if (fromBlock > toBlock) {
        return 0;
    }

    // Map the poolIds to poolAddresses
    const poolsMap = Object.fromEntries(poolIds.map((id) => [id.toLowerCase().slice(0, 42), id.toLowerCase()]));
    const poolAddresses = Object.keys(poolsMap);

    const range = rpcMaxBlockRange(chain);

    // Split the range into smaller chunks to avoid RPC limits, setting up to 5 times max block range
    // const toBlock = Math.min(fromBlock + 5 * range, endBlock);
    const events = await getEvents(
        fromBlock,
        toBlock,
        poolAddresses,
        ['Transfer'],
        config[chain].rpcUrl,
        range,
        ERC20Abi,
    );

    const balancesToFetch = _.uniqBy(
        events
            .filter((event) => poolAddresses.includes(event.address.toLowerCase()))
            .flatMap((event) => [
                { poolAddress: event.address.toLowerCase(), userAddress: (event.args?.from as string)?.toLowerCase() },
                { poolAddress: event.address.toLowerCase(), userAddress: (event.args?.to as string)?.toLowerCase() },
            ])
            .filter(
                (entry): entry is { poolAddress: string; userAddress: string } =>
                    Boolean(entry.userAddress) && entry.userAddress !== zeroAddress,
            ),
        (entry) => entry.poolAddress + entry.userAddress,
    );

    const balances =
        balancesToFetch.length > 0
            ? await multicallViem(
                  client,
                  balancesToFetch.map((entry) => ({
                      path: entry.poolAddress + '-' + entry.userAddress,
                      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
                      address: entry.poolAddress as `0x${string}`,
                      functionName: 'balanceOf',
                      args: [entry.userAddress as `0x${string}`],
                  })),
              )
            : {};

    const poolShares = Object.keys(balances).map((id) => {
        const [tokenAddress, userAddress] = id.toLowerCase().split('-');
        const poolId = poolsMap[tokenAddress];
        const balance = formatEther(balances[id]);

        return {
            id: id.toLowerCase(),
            poolId,
            chain,
            balance,
            balanceNum: parseFloat(balance),
            tokenAddress,
            userAddress,
        };
    });

    const operations = balancesToDb(poolShares, chain, toBlock, syncCategory);
    if (operations.length > 0) {
        try {
            await prisma.$transaction(operations);
        } catch (e: any) {
            logger.error('Failed to persist BPT balances from RPC', { chain, syncCategory, err: e });
        }
    }

    return toBlock - startBlock;
};

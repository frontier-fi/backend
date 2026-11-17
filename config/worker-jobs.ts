import { every } from '../apps/scheduler/intervals';
import { WorkerJob } from './types';

export const activeChainWorkerJobsV3: WorkerJob[] = [
    {
        name: 'add-pools-v3',
        interval: every(30, 'seconds'),
    },
    {
        name: 'sync-pools-v3',
        interval: every(30, 'seconds'),
    },
    {
        name: 'sync-join-exits-v3',
        interval: every(1, 'minutes'),
    },
    {
        name: 'sync-swaps-v3',
        interval: every(1, 'minutes'),
    },
    {
        name: 'sync-hook-data',
        interval: every(1, 'hours'),
    },
    {
        name: 'update-liquidity-24h-ago-v3',
        interval: every(5, 'minutes'),
    },
];

export const activeChainWorkerJobsGeneric: WorkerJob[] = [
    {
        name: 'update-liquidity-for-inactive-pools',
        interval: every(10, 'minutes'),
    },
    {
        name: 'sync-snapshots',
        interval: every(15, 'minutes'),
    },
    {
        name: 'user-sync-wallet-balances-for-all-pools',
        interval: every(20, 'seconds'),
    },
    {
        name: 'update-fee-volume-yield-all-pools',
        interval: every(30, 'minutes'),
    },
    {
        name: 'update-pool-apr',
        interval: every(2, 'minutes'),
    },
    {
        name: 'sync-erc4626-onchain-data',
        interval: every(20, 'minutes'),
    },
    {
        name: 'update-lifetime-values',
        interval: every(60, 'minutes'),
    },
];

// Scheduled once, not per chain. Each of these handlers covers every configured chain.
export const globalWorkerJobs: WorkerJob[] = [
    {
        name: 'update-token-prices',
        interval: every(15, 'minutes'),
    },
    {
        name: 'global-purge-old-tokenprices',
        interval: every(1, 'days'),
    },
    {
        name: 'sync-rate-provider-reviews',
        interval: every(15, 'minutes'),
    },
    {
        name: 'sync-erc4626-data',
        interval: every(15, 'minutes'),
    },
    {
        name: 'fetch-token-yields',
        interval: every(20, 'minutes'),
    },
    {
        name: 'sync-categories',
        interval: every(10, 'minutes'),
    },
    {
        name: 'sync-token-tvl',
        interval: every(30, 'minutes'),
    },
    {
        name: 'sync-token-content-data',
        interval: every(5, 'minutes'),
    },
];

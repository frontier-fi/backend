import type { Chain } from '@prisma/client';
import type { GqlChain, GqlHookType } from '../apps/api/gql/generated-schema';
import { AprHandlerConfigs } from '../modules/aprs/handlers/types';

export interface WorkerJob {
    name: string;
    interval: number;
}

export type DeploymentEnv = 'staging' | 'production';

export interface NetworkData {
    chain: {
        slug: string;
        id: number;
        prismaId: Chain;
        gqlId: GqlChain;
    };
    eth: {
        address: string;
        symbol: string;
        name: string;
    };
    weth: {
        address: string;
    };
    rpcUrl: string;
    rpcMaxBlockRange: number;
    acceptableSGLag: number;
    coingecko: {
        nativeAssetId: string;
        platformId: string;
        excludedTokenAddresses: string[];
    };
    subgraphs: {
        vault?: string;
        pools?: string;
    };
    protocolToken: 'bal';
    gyro?: {
        config: string;
    };
    // Active contract addresses from frontier-fi/deployments. Mock contracts are omitted.
    contracts: Record<string, string>;
    hooks?: Record<string, GqlHookType>;
    multicall: string;
    multicall3: string;
    aprHandlers: AprHandlerConfigs;
    avgBlockSpeed: number;
    workerJobs: WorkerJob[];
}

import type { Chain } from '@prisma/client';
import type { GqlChain, GqlHookType } from '../apps/api/gql/generated-schema';
import { AprHandlerConfigs } from '../modules/aprs/handlers/types';

export interface WorkerJob {
    name: string;
    interval: number;
}

export type DeploymentEnv = 'canary' | 'main';

export interface NetworkData {
    chain: {
        slug: string;
        id: number;
        nativeAssetAddress: string;
        wrappedNativeAssetAddress: string;
        prismaId: Chain;
        gqlId: GqlChain;
    };
    eth: {
        address: string;
        addressFormatted: string;
        symbol: string;
        name: string;
    };
    weth: {
        address: string;
        addressFormatted: string;
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
        startDate: string;
        balancerV3?: string;
        balancerPoolsV3?: string;
    };
    protocolToken: 'bal';
    bal?: {
        address: string;
    };
    gyro?: {
        config: string;
    };
    balancer: {
        v3: {
            vaultAddress: string;
            routerAddress: string;
            defaultSwapFeePercentage: string;
            defaultYieldFeePercentage: string;
            tokenAdmin?: string;
        };
    };
    hooks?: Record<string, GqlHookType>;
    multicall: string;
    multicall3: string;
    aprHandlers: AprHandlerConfigs;
    avgBlockSpeed: number;
    workerJobs: WorkerJob[];
}

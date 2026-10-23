import { AaveV3Sepolia } from '@aave-dao/aave-address-book';
import { env } from '../apps/env';
import { NetworkData } from './types';
import { activeChainWorkerJobsGeneric, activeChainWorkerJobsV3 } from './worker-jobs';

export default <NetworkData>{
    chain: {
        slug: 'sepolia',
        id: 11155111,
        prismaId: 'SEPOLIA',
        gqlId: 'SEPOLIA',
    },
    subgraphs: {
        vault: `https://api.subgraph.ormilabs.com/api/public/9298290c-99e5-4994-b44f-d1c4ec424e0d/subgraphs/vault-sepolia/b4662a4/gn`,
        pools: `https://api.subgraph.ormilabs.com/api/public/9298290c-99e5-4994-b44f-d1c4ec424e0d/subgraphs/pools-sepolia/b4662a4/gn`,
    },
    eth: {
        address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        symbol: 'ETH',
        name: 'Ether',
    },
    weth: {
        address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    },
    coingecko: {
        nativeAssetId: 'ethereum',
        platformId: 'ethereum',
        excludedTokenAddresses: [],
    },
    rpcUrl: env.DRPC_API_KEY
        ? `https://lb.drpc.live/sepolia/${env.DRPC_API_KEY}`
        : 'https://gateway.tenderly.co/public/sepolia',
    rpcMaxBlockRange: 10000,
    acceptableSGLag: 100, // ~1min
    protocolToken: 'bal',
    // Active addresses from frontier-fi/deployments addresses/_lookup.json. Mock contracts are omitted.
    contracts: {
        Authorizer: '0xEdFdDa22252399BDDAeE8d6D8e93c32cA3c31eeE',
        BatchRouter: '0x7D08bc34e444848983227E266F61146A7e935A94',
        BufferRouter: '0xf921Cc4B31417eED5FD1B82B15B8b5549b605630',
        CompositeLiquidityRouter: '0x96Eb97f030C04A98EF83191d9704e5Ba7836Bf3D',
        EclpLPOracleFactory: '0x38c0CD8D4A868c7123E0E2eC1C0fAD8614E1E1D9',
        GyroECLPPoolFactory: '0xED6D268cAdBea94c34E531C3401d41a882D66A8D',
        ProtocolFeeController: '0x9497e26dE55Af5C87Da7F4f57EbEbAFF0DDaBc1B',
        Router: '0xB3C45499aa0ad2fF5d586E7d473C75d5781c557B',
        StableLPOracleFactory: '0xB60578a04b839Bb22974D377d3BEC5abAE52362F',
        StablePoolFactory: '0xB74Fe587fad28adbf152b511E199665D56D40755',
        Vault: '0xFF00009C1A83Ec25434522ef355b99e9a70000FF',
        VaultAdmin: '0x06d62a054D4f18Fa5cCf3C4E893e2cD8878F9007',
        VaultExtension: '0xd883460167DB9a68B85ee0A3937b75a2B38d1B8E',
        VaultFactory: '0x2621Def28C3EF11Bd8d5D1670E45B22494fBb54e',
        WeightedLPOracleFactory: '0x5f3B2aEDF750372C784e2b5ab8A52Dc46273972d',
        WeightedPoolFactory: '0xC55Ea8a9de28CEDd9Eb1384CecD0D0437B71aB9a',
    },
    hooks: {},
    // Multicall3 from https://github.com/mds1/multicall deployments.json.
    multicall: '0x25Eef291876194AeFAd0D60Dff89e268b90754Bb',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    avgBlockSpeed: 1,
    aprHandlers: {
        ybAprHandler: {
            aave: {
                markets: [AaveV3Sepolia],
            },
        },
    },
    workerJobs: [...activeChainWorkerJobsGeneric, ...activeChainWorkerJobsV3],
};

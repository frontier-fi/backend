import {
    AaveV3Ethereum,
    AaveV3EthereumLido,
    AaveV4Ethereum,
    AaveV4EthereumSentoraCurated,
} from '@aave-dao/aave-address-book';
import { env } from '../apps/env';
import { NetworkData } from './types';
import { activeChainWorkerJobsGeneric, activeChainWorkerJobsV3 } from './worker-jobs';

export default <NetworkData>{
    chain: {
        slug: 'ethereum',
        id: 1,
        prismaId: 'MAINNET',
        gqlId: 'MAINNET',
    },
    subgraphs: {
        vault: `https://api.subgraph.ormilabs.com/api/public/9298290c-99e5-4994-b44f-d1c4ec424e0d/subgraphs/vault-ethereum/latest/gn`,
        pools: `https://api.subgraph.ormilabs.com/api/public/9298290c-99e5-4994-b44f-d1c4ec424e0d/subgraphs/pools-ethereum/latest/gn`,
    },
    eth: {
        address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        symbol: 'ETH',
        name: 'Ether',
        logoURI:
            'https://raw.githubusercontent.com/frontier-fi/tokenlists/main/src/assets/images/tokens/0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.png',
    },
    weth: {
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    },
    coingecko: {
        nativeAssetId: 'ethereum',
        platformId: 'ethereum',
        excludedTokenAddresses: [],
    },
    rpcUrl: env.DRPC_API_KEY
        ? `https://lb.drpc.live/ethereum/${env.DRPC_API_KEY}`
        : 'https://mainnet.gateway.tenderly.co',
    rpcMaxBlockRange: 5000,
    acceptableSGLag: 5, // ~1min
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
    // Immutable Vault parameters read from on-chain VaultAdmin getters.
    vaultParams: {
        minTradeAmount: 1000000n,
        minWrapAmount: 10000n,
    },
    hooks: {},
    // Multicall3 from https://github.com/mds1/multicall deployments.json.
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    aprHandlers: {
        merklAprHandler: true,
        ybAprHandler: {
            aave: {
                markets: [AaveV3Ethereum, AaveV3EthereumLido],
            },
            aaveV4: {
                markets: [AaveV4Ethereum, AaveV4EthereumSentoraCurated],
            },
            http: [
                {
                    url: 'https://liquid-api.fly.dev/weeth/apy',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee', // weETH
                            path: '$.displayApy',
                        },
                    ],
                },
                {
                    url: 'https://api.exchange.coinbase.com/wrapped-assets/CBETH/',
                    scale: 1,
                    extractors: [
                        {
                            type: 'path',
                            token: '0xbe9895146f7af43049ca1c1ae358b0541ea49704', // cbETH
                            path: '$.apy',
                        },
                    ],
                },
                {
                    url: 'https://eth-api.lido.fi/v1/protocol/steth/apr/sma',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', // wstETH
                            path: '$.data.smaApr',
                        },
                    ],
                },
                {
                    url: 'https://api.rocketpool.net/mainnet/reth/apr',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0xae78736cd615f374d3085123a210448e74fc6393', // rETH
                            path: '$.yearlyAPR',
                        },
                    ],
                },
                {
                    url: 'https://info-sky.blockanalitica.com/api/v1/savings-rate/?format=json',
                    scale: 1,
                    extractors: [
                        {
                            type: 'path',
                            token: '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd', // sUSDS
                            path: '$[0].ssr_rate',
                        },
                    ],
                },
                {
                    url: 'https://api.fluid.instad.app/v2/lending/1/tokens',
                    extractors: [
                        {
                            type: 'enumerate',
                            path: '$.data',
                            entries: (token: any): [string, number] => [
                                token.address.toLowerCase(),
                                parseFloat(token.supplyRate) / 10000,
                            ],
                        },
                    ],
                },
            ],
            teth: {
                address: '0xd11c452fc99cf405034ee446803b6f6c1f6d5ed8', // tETH
            },
        },
    },
    workerJobs: [...activeChainWorkerJobsV3, ...activeChainWorkerJobsGeneric],
};

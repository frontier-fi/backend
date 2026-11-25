import { AaveV3Monad } from '@aave-dao/aave-address-book';
import { env } from '../apps/env';
import { NetworkData } from './types';
import { activeChainWorkerJobsGeneric, activeChainWorkerJobsV3 } from './worker-jobs';

export default <NetworkData>{
    chain: {
        slug: 'monad',
        id: 143,
        prismaId: 'MONAD',
        gqlId: 'MONAD',
    },
    subgraphs: {
        vault: `https://api.subgraph.ormilabs.com/api/public/9298290c-99e5-4994-b44f-d1c4ec424e0d/subgraphs/vault-monad/latest/gn`,
        pools: `https://api.subgraph.ormilabs.com/api/public/9298290c-99e5-4994-b44f-d1c4ec424e0d/subgraphs/pools-monad/latest/gn`,
    },
    eth: {
        address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        symbol: 'MON',
        name: 'Monad',
    },
    weth: {
        address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
    },
    coingecko: {
        nativeAssetId: 'monad',
        platformId: 'monad',
        excludedTokenAddresses: [],
    },
    rpcUrl: env.DRPC_API_KEY ? `https://lb.drpc.live/monad/${env.DRPC_API_KEY}` : 'https://monad.gateway.tenderly.co',
    rpcMaxBlockRange: 10000,
    acceptableSGLag: 150, // ~1min
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
                markets: [AaveV3Monad],
            },
            http: [
                {
                    url: 'https://app.avantprotocol.com/api/savusdApy',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0x9648db94f1e6b19e7d755585542981f97dc806c6', // savUSD
                            path: '$.savusdApy',
                        },
                    ],
                },
                {
                    url: 'https://defi-api.yuzu.money/proxy/apy',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0x484be0540ad49f351eaa04eeb35df0f937d4e73f', // syzUSD
                            path: '$.data.syzusd_apy',
                        },
                    ],
                },
                {
                    url: 'https://blue-api.morpho.org/graphql',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: `{ assetByAddress(address: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", chainId: 1) { yield { apr } } }`,
                    }),
                    extractors: [
                        {
                            type: 'path',
                            token: '0xa3d68b74bf0528fdd07263c60d6488749044914b', // weETH
                            path: '$.data.assetByAddress.yield.apr',
                        },
                    ],
                },
                {
                    url: 'https://api.rocketpool.net/mainnet/reth/apr',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0xc50f2e735edd9dcd8ccd41ecfe9894e679e3195f', // rETH
                            path: '$.yearlyAPR',
                        },
                    ],
                },
                {
                    url: 'https://yields.llama.fi/chart/ee40513c-9356-4c53-9f26-446b484a8ae2',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0x1b68626dca36c7fe922fd2d55e4f631d962de19c', // shMON
                            path: '$.data[-1:].apyBase',
                        },
                    ],
                },
                {
                    url: 'https://yields.llama.fi/chart/d711af54-e736-470f-8a22-431a23de76df',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0xe1bca19baa63894d374578320551633320436523', // CSUSDC
                            path: '$.data[-1:].apyBase',
                        },
                    ],
                },
                {
                    // gMON
                    url: 'https://indexer.hyperindex.xyz/a7dd119/v1/graphql',
                    body: JSON.stringify({
                        query: `{
                            CoreVault_APY {
                                totalAPR
                            }
                        }`,
                    }),
                    headers: { 'Content-Type': 'application/json' },
                    scale: 10000,
                    extractors: [
                        {
                            type: 'path',
                            token: '0x8498312a6b3cbd158bf0c93abdcf29e6e4f55081',
                            path: '$.data.CoreVault_APY[0].totalAPR',
                        },
                    ],
                },
                {
                    // sMON
                    url: 'https://kintsu.xyz/api/public/apy',
                    extractors: [
                        {
                            type: 'path',
                            token: '0xa3227c5969757783154c60bf0bc1944180ed81b9',
                            path: '$.data[0].apy',
                        },
                    ],
                },
                {
                    // Neverland: one request for all wrapped reserves, keyed by underlying reserve address.
                    url: 'https://app.neverland.money/api/pool-apy',
                    scale: 100,
                    extractors: [
                        ...(
                            [
                                [
                                    '0xdb39a9d4a1f1b4e93a5684d602207628ad60613c',
                                    '0x3bd359c1119da7da1d913d1c4d2b7c461115433a',
                                ], // wnWMON
                                [
                                    '0x82c370ba90e38ef6acd8b1b078d34fd86fc6bac9',
                                    '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
                                ], // wnAUSD
                                [
                                    '0x8d5c2df3eef09088fcccf3376d8ecd0dd505f642',
                                    '0x754704bc059f8c67012fed69bc8a327a5aafb603',
                                ], // wnUSDC
                                [
                                    '0x8959f4e6ed1f4567a464959793d5f8f6f33c1c8b',
                                    '0x0555e30da8f98308edb960aa94c0db47230d2b9c',
                                ], // wnWBTC
                                [
                                    '0x98a297e6424787e57af119949d7e00b721f832bb',
                                    '0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b',
                                ], // wnCBBTC
                                [
                                    '0xb3b850ac62b89fe9f4efb652b516108a8aeb8848',
                                    '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242',
                                ], // wnWETH
                                [
                                    '0x4e8aaecce10ad9394e96fe5f2bd4e587a7b04298',
                                    '0xe7cd86e13ac4309349f30b3435a9d337750fc82d',
                                ], // wnUSDT0
                                [
                                    '0x29d2075e5151b1a6863bdc40ea86bd5e8afd1705',
                                    '0x8498312a6b3cbd158bf0c93abdcf29e6e4f55081',
                                ], // wnGMON
                                [
                                    '0x08139339dd9a480ceb84d9c7cce48be436db20b3',
                                    '0xa3227c5969757783154c60bf0bc1944180ed81b9',
                                ], // wnSMON
                                [
                                    '0x5e073494678fb7fa4a05bb17d45941dd9dc469c1',
                                    '0x1b68626dca36c7fe922fd2d55e4f631d962de19c',
                                ], // wnSHMON
                            ] as const
                        ).map(([token, reserve]) => ({
                            type: 'path' as const,
                            token,
                            path: `$.reserves.${reserve}.supply.baseAPY`,
                        })),
                        {
                            // wnloAZND earns the reserve's external APY on top of its base APY.
                            type: 'enumerate',
                            path: "$.reserves[?(@property === '0x9c82eb49b51f7dc61e22ff347931ca32adc6cd90')]",
                            entries: (reserve: any): [string, number] => [
                                '0xd786f7569c39a9f64e6a54eb77db21364e90f279',
                                Number(reserve.supply.baseAPY) + Number(reserve.supply.externalAPY),
                            ],
                        },
                    ],
                },
                {
                    url: 'https://eth-api.lido.fi/v1/protocol/steth/apr/sma',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0x10aeaf63194db8d453d4d85a06e5efe1dd0b5417', // wstETH
                            path: '$.data.smaApr',
                        },
                    ],
                },
                {
                    url: 'https://api.maple.finance/v2/graphql',
                    body: JSON.stringify({
                        query: `{
                            syrupGlobals {
                                apy
                            }
                        }`,
                    }),
                    headers: { 'Content-Type': 'application/json' },
                    scale: 1e30,
                    extractors: [
                        {
                            type: 'path',
                            token: '0xab6e5a0c3799d020c790d34f7b2c02639e238af7', // syrupUSDC
                            path: '$.data.syrupGlobals.apy',
                        },
                    ],
                },
                {
                    url: 'https://ethena.fi/api/yields/protocol-and-staking-yield',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2', // sUSDe
                            path: '$.stakingYield.value',
                        },
                    ],
                },
                {
                    // aBIL
                    url: 'https://mainnet-api.monday.trade/rwa/api/v2/stock-yield/aBIL',
                    scale: 100,
                    extractors: [
                        {
                            type: 'path',
                            token: '0x4fc5b9f8933597d3ecf84d0611687e1dc8dd576f',
                            path: '$.data.apr',
                        },
                    ],
                },
                {
                    url: 'https://blue-api.morpho.org/graphql',
                    body: JSON.stringify({
                        query: `{
                            vaults(first: 1000, where: { chainId_in: [143], apy_gte: 0.00001 }) {
                                items {
                                    address
                                    state {
                                        apy
                                        fee
                                        netApy
                                    }
                                }
                            }
                        }`,
                    }),
                    headers: { 'Content-Type': 'application/json' },
                    extractors: [
                        {
                            type: 'enumerate',
                            path: '$.data.vaults.items',
                            entries: (vault: any): [string, number] => [
                                vault.address.toLowerCase(),
                                vault.state.apy * (1 - vault.state.fee),
                            ],
                        },
                    ],
                },
                {
                    url: 'https://blue-api.morpho.org/graphql',
                    body: JSON.stringify({
                        query: `{
                            vaultV2s(first: 500, where: { chainId_in: [143], apy_gte: 0.00001 }) {
                                items {
                                    address
                                    avgNetApy
                                }
                            }
                        }`,
                    }),
                    headers: { 'Content-Type': 'application/json' },
                    extractors: [
                        {
                            type: 'enumerate',
                            path: '$.data.vaultV2s.items',
                            entries: (vault: any): [string, number] => [vault.address.toLowerCase(), vault.avgNetApy],
                        },
                    ],
                },
            ],
            // Blueberry vault yield doesn't track any single Curvance market's supply APY
            // (blbAUSD's market reported 0% while the vault earned ~9%), so use realised rate growth.
            // Needs 7 days of historical state, which the keyless Tenderly RPC doesn't serve: set DRPC_API_KEY.
            rateProvider: {
                chain: 'MONAD',
                intervalInDays: 7,
                rateProviders: [
                    {
                        tokenAddress: '0x215394b5677cb7a18b6fa8cc2cd155c024ee6b2e', // blbUSDC
                        rateProviderAddress: '0xa321a4bc2a55e9ec674897fe3fc9dd08beff1d5c',
                    },
                    {
                        tokenAddress: '0xc2ddc1004ca0d6cc4bfd1dcd03dcf855bed8e670', // blbAUSD
                        rateProviderAddress: '0x497bdbc39b9f70b7ce781cc74e45e1cb897843c0',
                    },
                ],
            },
        },
    },
    workerJobs: [...activeChainWorkerJobsV3, ...activeChainWorkerJobsGeneric],
};

import { Chain, PrismaPoolType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { PoolType } from '../subgraphs/pools/generated/types';
import { V3JoinedSubgraphPool } from '../subgraphs';
import { poolUpsertTransformerV3 } from './pool-upsert-transformer-v3';

const POOL = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FACTORY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN = '0xcccccccccccccccccccccccccccccccccccccccc';
const RATE = '0xdddddddddddddddddddddddddddddddddddddddd';
const FEE_MANAGER = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const PARENT = '0x3333333333333333333333333333333333333333';
const CHILD = '0x4444444444444444444444444444444444444444';
const NESTED = '0x5555555555555555555555555555555555555555';

const pool = (factoryType: string, extra: Record<string, unknown> = {}) =>
    ({
        id: POOL,
        symbol: 'P',
        name: 'Pool',
        swapFeeManager: FEE_MANAGER,
        pauseManager: null,
        poolCreator: CREATOR,
        blockTimestamp: '10',
        swapFee: '0.01',
        totalShares: '1',
        isPaused: false,
        isInRecoveryMode: false,
        liquidityManagement: {},
        hookConfig: null,
        factory: { type: factoryType, id: FACTORY, version: 1 },
        tokens: [
            {
                address: TOKEN,
                decimals: 18,
                symbol: 'T',
                name: 'Token',
                index: 0,
                balance: '1',
                paysYieldFees: true,
                scalingFactor: '1',
                nestedPool: null,
            },
        ],
        rateProviders: [{ address: RATE }],
        weightedParams: { weights: ['1'] },
        stableParams: { amp: '200' },
        eclpParams: { alpha: '1', beta: '2' },
        ...extra,
    }) as unknown as V3JoinedSubgraphPool;

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const WETH = '0x7b79995e5f793a07bc00c21412e50ecae098e7f9';
const DAI = '0xb77eb1a70a96fdaaeb31db1b42f2b8b5846b2613';

const hookOff = {
    hook: { address: ZERO },
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
};

const liquidityOn = {
    disableUnbalancedLiquidity: false,
    enableAddLiquidityCustom: false,
    enableDonation: false,
    enableRemoveLiquidityCustom: false,
};

function tokenRow(
    address: string,
    decimals: number,
    symbol: string,
    name: string,
    index: number,
    balance: string,
    scalingFactor: string,
) {
    return {
        address,
        decimals,
        symbol,
        name,
        index,
        balance,
        paysYieldFees: false,
        scalingFactor,
        nestedPool: null,
    };
}

// Shapes returned by the Sepolia vault and pools subgraphs for the three pools with real liquidity.
function sepoliaPool(kind: 'gyro' | 'stable' | 'weighted', extra: Record<string, unknown> = {}) {
    if (kind === 'gyro') {
        return pool(PoolType.Eclp, {
            id: '0xbfa2c112f1987854c6922505d06a9d9e897e2bf9',
            symbol: 'ECLP-BPT',
            name: 'weth-usdc',
            swapFee: '0.001',
            totalShares: '1.000000944745439528',
            factory: { type: PoolType.Eclp, id: '0xed6d268cadbea94c34e531c3401d41a882d66a8d', version: 2 },
            tokens: [
                tokenRow(USDC, 6, 'USDC', 'USDC', 0, '2.116975', '1000000000000'),
                tokenRow(WETH, 18, 'WETH', 'Wrapped Ether', 1, '0.000000100002116975', '1'),
            ],
            rateProviders: [{ address: ZERO }, { address: ZERO }],
            weightedParams: null,
            eclpParams: { alpha: '0.90909090909090909', beta: '1.1', lambda: '4' },
            hookConfig: hookOff,
            liquidityManagement: liquidityOn,
            ...extra,
        });
    }
    if (kind === 'stable') {
        return pool(PoolType.Stable, {
            id: '0x6c0705aa00bbc8476ec0b6d94fa5aa492e75b697',
            symbol: 'S-BPT',
            name: 'DAI/USDC',
            swapFee: '0.001',
            totalShares: '0.2',
            factory: { type: PoolType.Stable, id: '0xb74fe587fad28adbf152b511e199665d56d40755', version: 1 },
            tokens: [
                tokenRow(USDC, 6, 'USDC', 'USDC', 0, '0.11', '1000000000000'),
                tokenRow(DAI, 18, 'DAI', 'Dai Stablecoin', 1, '0.090019968758896058', '1'),
            ],
            rateProviders: [{ address: ZERO }, { address: ZERO }],
            weightedParams: null,
            stableParams: { amp: '100' },
            hookConfig: hookOff,
            liquidityManagement: liquidityOn,
            ...extra,
        });
    }
    return pool(PoolType.Weighted, {
        id: '0xd181617f85b6ff1728211c53c0a2b8108bd4a69d',
        symbol: 'W-BPT',
        name: 'weth-usdc',
        swapFee: '0.003',
        totalShares: '0.002162277660168315',
        factory: { type: PoolType.Weighted, id: '0xc55ea8a9de28cedd9eb1384cecd0d0437b71ab9a', version: 2 },
        tokens: [
            tokenRow(USDC, 6, 'USDC', 'USDC', 0, '0.078378', '1000000000000'),
            tokenRow(WETH, 18, 'WETH', 'Wrapped Ether', 1, '0.000059676032336884', '1'),
        ],
        rateProviders: [{ address: ZERO }, { address: ZERO }],
        weightedParams: { weights: ['0.5', '0.5'] },
        hookConfig: hookOff,
        liquidityManagement: liquidityOn,
        ...extra,
    });
}

describe('poolUpsertTransformerV3', () => {
    it('maps weighted, stable, and gyroE pools', () => {
        const weighted = poolUpsertTransformerV3(pool(PoolType.Weighted), Chain.SEPOLIA, 5);
        const stable = poolUpsertTransformerV3(pool(PoolType.Stable), Chain.SEPOLIA, 5);
        const gyro = poolUpsertTransformerV3(pool(PoolType.Eclp), Chain.SEPOLIA, 5);

        expect(weighted?.pool.type).toBe(PrismaPoolType.WEIGHTED);
        expect(weighted?.pool.protocolVersion).toBe(3);
        expect(weighted?.pool.id).toBe(POOL);
        expect(stable?.pool.type).toBe(PrismaPoolType.STABLE);
        expect(stable?.pool.typeData).toMatchObject({ amp: '200' });
        expect(gyro?.pool.type).toBe(PrismaPoolType.ECLP);
        expect(gyro?.pool.typeData).toMatchObject({ alpha: '1', beta: '2' });
    });

    it('returns null for a factory type other than weighted, stable, or gyroE', () => {
        expect(poolUpsertTransformerV3(pool('ReClamm'), Chain.SEPOLIA, 5)).toBeNull();
    });

    it('stores a checksummed address in lowercase and keeps weights only on weighted pools', () => {
        const checksummedPool = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
        const weighted = poolUpsertTransformerV3(
            pool(PoolType.Weighted, {
                id: checksummedPool,
                tokens: [
                    {
                        address: TOKEN,
                        decimals: 6,
                        symbol: 'USDC',
                        name: 'USDC',
                        index: 0,
                        balance: '1',
                        paysYieldFees: false,
                        scalingFactor: '1000000000000',
                        nestedPool: null,
                    },
                ],
                weightedParams: { weights: ['0.5'] },
                rateProviders: [{ address: RATE }],
            }),
            Chain.SEPOLIA,
            5,
        );

        expect(weighted?.pool.id).toBe(checksummedPool.toLowerCase());
        expect(weighted?.pool.factory).toBe(FACTORY);
        expect(weighted?.tokens.map((token) => token.address)).toEqual([TOKEN, checksummedPool.toLowerCase()]);
        expect(weighted?.poolToken[0].weight).toBe('0.5');
        expect(weighted?.poolToken[0].priceRateProvider).toBe(RATE);
        expect(weighted?.poolToken[0].exemptFromProtocolYieldFee).toBe(true);
        expect(weighted?.poolDynamicData.totalShares).toBe(parseEther('1').toString());

        const stable = poolUpsertTransformerV3(pool(PoolType.Stable, { weightedParams: null }), Chain.SEPOLIA, 5);
        expect(stable?.poolToken[0].weight).toBeNull();
    });

    it('flattens a nested pool token into the expanded token list', () => {
        const nested = poolUpsertTransformerV3(
            pool(PoolType.Weighted, {
                tokens: [
                    {
                        address: PARENT,
                        decimals: 18,
                        symbol: 'BPT',
                        name: 'Nested',
                        index: 0,
                        balance: '1',
                        paysYieldFees: true,
                        scalingFactor: '1',
                        nestedPool: {
                            id: NESTED,
                            tokens: [{ address: CHILD }],
                        },
                    },
                ],
            }),
            Chain.SEPOLIA,
            5,
        );

        expect(nested?.poolExpandedTokens).toEqual([
            { poolId: POOL, chain: Chain.SEPOLIA, tokenAddress: PARENT, nestedPoolId: NESTED },
            { poolId: POOL, chain: Chain.SEPOLIA, tokenAddress: CHILD, nestedPoolId: NESTED },
        ]);
        expect(nested?.poolToken[0].nestedPoolId).toBe(NESTED);
    });

    it('maps the live Sepolia GyroE, stable, and weighted pools', () => {
        const gyro = poolUpsertTransformerV3(sepoliaPool('gyro'), Chain.SEPOLIA, 11940608);
        const stable = poolUpsertTransformerV3(sepoliaPool('stable'), Chain.SEPOLIA, 11940608);
        const weighted = poolUpsertTransformerV3(sepoliaPool('weighted'), Chain.SEPOLIA, 11940608);

        expect(gyro?.pool).toMatchObject({
            id: '0xbfa2c112f1987854c6922505d06a9d9e897e2bf9',
            type: PrismaPoolType.ECLP,
            symbol: 'ECLP-BPT',
            hook: undefined,
            typeData: { alpha: '0.90909090909090909', beta: '1.1', lambda: '4' },
        });
        expect(gyro?.poolToken.map((token) => token.address)).toEqual([
            '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
            '0x7b79995e5f793a07bc00c21412e50ecae098e7f9',
        ]);
        expect(gyro?.poolToken.every((token) => token.weight === null)).toBe(true);

        expect(stable?.pool).toMatchObject({
            id: '0x6c0705aa00bbc8476ec0b6d94fa5aa492e75b697',
            type: PrismaPoolType.STABLE,
            name: 'DAI/USDC',
            typeData: { amp: '100' },
        });
        expect(stable?.poolDynamicData.totalShares).toBe(parseEther('0.2').toString());
        expect(stable?.poolDynamicData.swapFee).toBe('0.001');

        expect(weighted?.pool).toMatchObject({
            id: '0xd181617f85b6ff1728211c53c0a2b8108bd4a69d',
            type: PrismaPoolType.WEIGHTED,
        });
        expect(weighted?.poolToken.map((token) => token.weight)).toEqual(['0.5', '0.5']);
        expect(weighted?.poolDynamicData.swapFee).toBe('0.003');
    });

    it('stores a configured hook and ignores the zero address', () => {
        const hooked = poolUpsertTransformerV3(
            sepoliaPool('stable', {
                hookConfig: {
                    hook: { address: '0xbb1761af481364a6bd7fdbdb8cfa23abd85f0263' },
                    enableHookAdjustedAmounts: false,
                    shouldCallAfterSwap: false,
                    shouldCallBeforeSwap: true,
                    shouldCallAfterInitialize: false,
                    shouldCallBeforeInitialize: false,
                    shouldCallAfterAddLiquidity: false,
                    shouldCallBeforeAddLiquidity: false,
                    shouldCallAfterRemoveLiquidity: false,
                    shouldCallBeforeRemoveLiquidity: false,
                    shouldCallComputeDynamicSwapFee: false,
                },
            }),
            Chain.SEPOLIA,
            1,
        );

        expect(hooked?.pool.hook?.type).toBe('UNKNOWN');
        expect(hooked?.pool.hook?.address).toBe('0xbb1761af481364a6bd7fdbdb8cfa23abd85f0263');
        expect(sepoliaPool('stable').hookConfig.hook.address).toBe('0x0000000000000000000000000000000000000000');
        expect(poolUpsertTransformerV3(sepoliaPool('stable'), Chain.SEPOLIA, 1)?.pool.hook).toBeUndefined();
    });

    it('matches rateProviders by token.address and defaults missing entries to zeroAddress', () => {
        const wethRateProvider = '0x9999999999999999999999999999999999999999';
        const checksummedWeth = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9';
        const sparse = poolUpsertTransformerV3(
            sepoliaPool('weighted', {
                // Only token[1] (WETH) has a RateProvider row; token[0] (USDC) has none
                rateProviders: [{ address: wethRateProvider, token: { address: checksummedWeth } }],
            }),
            Chain.SEPOLIA,
            1,
        );

        expect(sparse?.poolToken[0].address).toBe(USDC);
        expect(sparse?.poolToken[0].priceRateProvider).toBe(ZERO);
        expect(sparse?.poolToken[1].address).toBe(WETH);
        expect(sparse?.poolToken[1].priceRateProvider).toBe(wethRateProvider);

        const empty = poolUpsertTransformerV3(sepoliaPool('weighted', { rateProviders: [] }), Chain.SEPOLIA, 1);
        expect(empty?.poolToken.map((t) => t.priceRateProvider)).toEqual([ZERO, ZERO]);
    });

    it('preserves StableParams amp ramp schedule fields on typeData', () => {
        const rampingStable = poolUpsertTransformerV3(
            sepoliaPool('stable', {
                stableParams: {
                    __typename: 'StableParams',
                    amp: '100',
                    ampIsUpdating: true,
                    ampStartValue: '100',
                    ampEndValue: '500',
                    ampStartTime: '1700000000',
                    ampEndTime: '1700086400',
                },
            }),
            Chain.SEPOLIA,
            11940608,
        );

        expect(rampingStable?.pool.typeData).toEqual({
            amp: '100',
            ampIsUpdating: true,
            ampStartValue: '100',
            ampEndValue: '500',
            ampStartTime: '1700000000',
            ampEndTime: '1700086400',
        });
    });

    it('maps subgraph v3 enhancements (PoolToken.rateProvider, ERC4626 underlyingToken + buffer, and aggregate fees)', () => {
        const waUsdc = '0x8888888888888888888888888888888888888888';
        const waUsdcRateProvider = '0x7777777777777777777777777777777777777777';
        const boosted = poolUpsertTransformerV3(
            pool(PoolType.Stable, {
                aggregateSwapFee: '0.5',
                aggregateYieldFee: '0.25',
                rateProviders: [],
                tokens: [
                    {
                        address: waUsdc,
                        decimals: 6,
                        symbol: 'waUSDC',
                        name: 'Wrapped Aave USDC',
                        index: 0,
                        balance: '1000',
                        paysYieldFees: true,
                        scalingFactor: '1000000000000',
                        rateProvider: waUsdcRateProvider,
                        tokenType: 2,
                        buffer: {
                            wrappedBalance: '500',
                            underlyingBalance: '525',
                        },
                        token: {
                            isErc4626: true,
                            underlyingToken: {
                                address: USDC,
                                decimals: 6,
                                symbol: 'USDC',
                                name: 'USD Coin',
                            },
                        },
                        nestedPool: null,
                    },
                    {
                        address: DAI,
                        decimals: 18,
                        symbol: 'DAI',
                        name: 'Dai Stablecoin',
                        index: 1,
                        balance: '1000',
                        paysYieldFees: false,
                        scalingFactor: '1',
                        rateProvider: ZERO,
                        tokenType: 0,
                        buffer: null,
                        token: {
                            isErc4626: false,
                            underlyingToken: null,
                        },
                        nestedPool: null,
                    },
                ],
            }),
            Chain.SEPOLIA,
            42,
        );

        expect(boosted?.poolDynamicData.aggregateSwapFee).toBe('0.5');
        expect(boosted?.poolDynamicData.protocolSwapFee).toBe('0.5');
        expect(boosted?.poolDynamicData.aggregateYieldFee).toBe('0.25');
        expect(boosted?.poolDynamicData.protocolYieldFee).toBe('0.25');
        expect(boosted?.poolToken[0].priceRateProvider).toBe(waUsdcRateProvider);
        expect(boosted?.poolToken[1].priceRateProvider).toBe(ZERO);

        const waTokenRow = boosted?.tokens.find((t) => t.address === waUsdc);
        expect(waTokenRow).toMatchObject({
            address: waUsdc,
            underlyingTokenAddress: USDC,
            bufferBalanceWrapped: '500',
            bufferBalanceUnderlying: '525',
        });

        const underlyingRow = boosted?.tokens.find((t) => t.address === USDC);
        expect(underlyingRow).toMatchObject({
            address: USDC,
            decimals: 6,
            symbol: 'USDC',
            name: 'USD Coin',
        });

        expect(boosted?.poolExpandedTokens.map((t) => t.tokenAddress)).toEqual([waUsdc, USDC, DAI]);
    });
});

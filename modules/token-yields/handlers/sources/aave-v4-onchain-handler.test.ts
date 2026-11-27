import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hex } from 'viem';
import { aaveV4OnchainHandler, calculateAaveV4SupplyApr } from './aave-v4-onchain-handler';

const multicallMock = vi.fn();

vi.mock('../../../sources/viem-client', () => ({
    getViemClient: () => ({
        multicall: (params: any) => multicallMock(params),
    }),
}));

const CORE_HUB = '0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9' as Hex;
const BASE_HUB = '0xa4d5947Eb727A052bae69C593FfC84247EC9864E' as Hex;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Hex;
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Hex;
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Hex;
const MAIN_SPOKE = '0x94e7A5dCbE816e498b89aB752661904E2F56c485' as Hex;
const WA_CORE_USDC = '0x531E90a2376902DE8915789Fcc1075e3B0c153E7' as Hex;
const WA_CORE_USDC_ALT = '0x4131E0B2E7AFeCEAf3d3b4225aA61a3B2B7535b8' as Hex;
const WA_CORE_WSTETH = '0xcb0E7dA9c635628f6d4827355AeCa75aB8d3560f' as Hex;
const WA_EQUITIES_USDC = '0x7081CE7EB1282c53CF38EA9B622f6269cb8FeFDc' as Hex;
const SPOOFED_SPOKE = '0x9999999999999999999999999999999999999999' as Hex;

describe('calculateAaveV4SupplyApr', () => {
    it('computes supply APR from drawnRate, drawnIndex, drawnShares, premiumShares, liquidityFee, and addedAssets', () => {
        // Mirrors live Ethereum CORE_HUB USDC numbers (~4.01%)
        const ethApr = calculateAaveV4SupplyApr({
            drawnRate: 51_591_180_921_024_095_355_110_307n,
            drawnIndex: 1_033_376_509_394_505_607_203_196_090n,
            drawnShares: 89_713_555_273_607n,
            premiumShares: 0n,
            liquidityFee: 1000,
            addedAssets: 107_367_748_801_727n,
        });
        expect(ethApr).toBeCloseTo(0.040092, 5);

        // Mirrors live Base EQUITIES_HUB USDC with non-zero premiumShares (~2.037%)
        const baseApr = calculateAaveV4SupplyApr({
            drawnRate: 31_662_188_906_077_335_024_744_183n,
            drawnIndex: 1_004_924_496_728_164_592_113_206_537n,
            drawnShares: 8_319_778_331_570n,
            premiumShares: 26_260_308_652n,
            liquidityFee: 1000,
            addedAssets: 11_733_286_740_759n,
        });
        expect(baseApr).toBeCloseTo(0.020369, 5);
    });

    it('returns 0 for zero supply, zero rate, zero debt, or 100% fee', () => {
        const valid = {
            drawnRate: 50_000_000_000_000_000_000_000_000n,
            drawnIndex: 1_000_000_000_000_000_000_000_000_000n,
            drawnShares: 1_000n,
            premiumShares: 0n,
            liquidityFee: 1000,
            addedAssets: 2_000n,
        };
        expect(calculateAaveV4SupplyApr({ ...valid, addedAssets: 0n })).toBe(0);
        expect(calculateAaveV4SupplyApr({ ...valid, drawnRate: 0n })).toBe(0);
        expect(calculateAaveV4SupplyApr({ ...valid, drawnShares: 0n, premiumShares: 0n })).toBe(0);
        expect(calculateAaveV4SupplyApr({ ...valid, liquidityFee: 10_000 })).toBe(0);
    });
});

describe('aaveV4OnchainHandler', () => {
    beforeEach(() => {
        multicallMock.mockReset();
    });

    it('dynamically discovers TokenizationSpokes across assets, ignores borrowing spokes and mismatched spokes, and keeps 0-APR spokes', async () => {
        // Round 1: getAssetCount on CORE_HUB -> 2 assets
        multicallMock.mockResolvedValueOnce([{ status: 'success', result: 2n }]);

        // Round 2: getAsset, getAssetDrawnRate, getAssetDrawnIndex, getAddedAssets, getSpokeCount for assetId 0 (USDC) and assetId 1 (wstETH)
        multicallMock.mockResolvedValueOnce([
            // Asset 0: USDC -> 5% drawnRate, 80% util, 10% fee => 3.6% supply APR, 4 spokes (MAIN_SPOKE, WA_CORE_USDC, WA_CORE_USDC_ALT, SPOOFED_SPOKE)
            {
                status: 'success',
                result: { drawnShares: 800n, premiumShares: 0n, liquidityFee: 1000, underlying: USDC },
            },
            { status: 'success', result: 50_000_000_000_000_000_000_000_000n },
            { status: 'success', result: 1_000_000_000_000_000_000_000_000_000n },
            { status: 'success', result: 1_000n },
            { status: 'success', result: 4n },
            // Asset 1: wstETH -> 0% drawnRate => 0% supply APR, 2 spokes (MAIN_SPOKE, WA_CORE_WSTETH)
            {
                status: 'success',
                result: { drawnShares: 0n, premiumShares: 0n, liquidityFee: 0, underlying: WSTETH },
            },
            { status: 'success', result: 0n },
            { status: 'success', result: 1_000_000_000_000_000_000_000_000_000n },
            { status: 'success', result: 500n },
            { status: 'success', result: 2n },
        ]);

        // Round 3: getSpokeAddress for asset 0 (4 spokes) and asset 1 (2 spokes)
        multicallMock.mockResolvedValueOnce([
            { status: 'success', result: MAIN_SPOKE },
            { status: 'success', result: WA_CORE_USDC },
            { status: 'success', result: WA_CORE_USDC_ALT },
            { status: 'success', result: SPOOFED_SPOKE },
            { status: 'success', result: MAIN_SPOKE },
            { status: 'success', result: WA_CORE_WSTETH },
        ]);

        // Round 4: hub(), assetId(), asset() for 5 unique spokes: MAIN_SPOKE, WA_CORE_USDC, WA_CORE_USDC_ALT, SPOOFED_SPOKE, WA_CORE_WSTETH
        multicallMock.mockResolvedValueOnce([
            // MAIN_SPOKE (regular borrowing spoke, reverts on ERC-4626/TokenizationSpoke getters)
            { status: 'failure', error: new Error('revert') },
            { status: 'failure', error: new Error('revert') },
            { status: 'failure', error: new Error('revert') },
            // WA_CORE_USDC
            { status: 'success', result: CORE_HUB },
            { status: 'success', result: 0n },
            { status: 'success', result: USDC },
            // WA_CORE_USDC_ALT (second TokenizationSpoke on same hub/assetId)
            { status: 'success', result: CORE_HUB },
            { status: 'success', result: 0n },
            { status: 'success', result: USDC },
            // SPOOFED_SPOKE (wrong underlying asset)
            { status: 'success', result: CORE_HUB },
            { status: 'success', result: 0n },
            { status: 'success', result: WSTETH },
            // WA_CORE_WSTETH
            { status: 'success', result: CORE_HUB },
            { status: 'success', result: 1n },
            { status: 'success', result: WSTETH },
        ]);

        const aprs = await aaveV4OnchainHandler({
            markets: [
                {
                    CHAIN_ID: 1,
                    HUBS: { CORE_HUB },
                },
            ],
        });

        expect(aprs).toHaveLength(3);
        expect(aprs[0]).toEqual({ address: WA_CORE_USDC.toLowerCase(), apr: expect.closeTo(0.036, 8) });
        expect(aprs[1]).toEqual({ address: WA_CORE_USDC_ALT.toLowerCase(), apr: expect.closeTo(0.036, 8) });
        expect(aprs[2]).toEqual({ address: WA_CORE_WSTETH.toLowerCase(), apr: 0 });
        expect(multicallMock).toHaveBeenCalledTimes(4);
    });

    it('supports Base Aave V4 markets with premium shares', async () => {
        multicallMock
            .mockResolvedValueOnce([{ status: 'success', result: 1n }])
            .mockResolvedValueOnce([
                {
                    status: 'success',
                    result: { drawnShares: 700n, premiumShares: 100n, liquidityFee: 1000, underlying: BASE_USDC },
                },
                { status: 'success', result: 40_000_000_000_000_000_000_000_000n }, // 4%
                { status: 'success', result: 1_000_000_000_000_000_000_000_000_000n },
                { status: 'success', result: 1_000n },
                { status: 'success', result: 1n },
            ])
            .mockResolvedValueOnce([{ status: 'success', result: WA_EQUITIES_USDC }])
            .mockResolvedValueOnce([
                { status: 'success', result: BASE_HUB },
                { status: 'success', result: 0n },
                { status: 'success', result: BASE_USDC },
            ]);

        const aprs = await aaveV4OnchainHandler({
            markets: [{ CHAIN_ID: 8453, HUBS: { EQUITIES_HUB: BASE_HUB } }],
        });

        // 0.04 * ((700 + 100) / 1000) * 0.9 = 0.0288
        expect(aprs).toEqual([{ address: WA_EQUITIES_USDC.toLowerCase(), apr: expect.closeTo(0.0288, 8) }]);
    });

    it('throws when all getAssetCount calls fail', async () => {
        multicallMock.mockResolvedValueOnce([{ status: 'failure', error: new Error('rpc down') }]);

        await expect(
            aaveV4OnchainHandler({
                markets: [{ CHAIN_ID: 1, HUBS: { CORE_HUB } }],
            }),
        ).rejects.toThrow('Failed to fetch Aave V4 onchain APR: rpc down');
    });
});

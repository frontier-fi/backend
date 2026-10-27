import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionResult, encodeFunctionResult } from 'viem';
import aaveUiPoolDataProvider, { aaveUiPoolDataProviderLegacy } from './abis/aave-ui-pool-data-provider';
import { aaveOnchainHandler } from './aave-onchain-handler';

const readContractMock = vi.fn();

vi.mock('../../../sources/viem-client', () => ({
    getViemClient: () => ({
        readContract: (params: any) => readContractMock(params),
    }),
}));

describe('aaveOnchainHandler', () => {
    const underlying = '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357' as const;
    const staticAToken = '0xDE46e43F46ff74A23a65EBb0580cbe3dFE684a17' as const;
    const aToken = '0x29598b72eb5CeBd806C5dCD549490FdA35B13cD8' as const;

    const sepoliaMarket = {
        CHAIN_ID: 11155111,
        UI_POOL_DATA_PROVIDER: '0x69529987FA4A075D0C00B0128fa848dc9ebbE9CE' as const,
        POOL_ADDRESSES_PROVIDER: '0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A' as const,
        ASSETS: {
            DAI: {
                UNDERLYING: underlying,
                A_TOKEN: aToken,
                STATIC_A_TOKEN: staticAToken,
            },
        },
    };

    it('falls back to legacy Aave v3.0/v3.1 UiPoolDataProvider ABI when Sepolia returns stableBorrowRate fields', async () => {
        const legacyEncoded = encodeFunctionResult({
            abi: aaveUiPoolDataProviderLegacy,
            functionName: 'getReservesData',
            result: [
                [
                    {
                        underlyingAsset: underlying,
                        name: 'Dai Stablecoin',
                        symbol: 'DAI',
                        decimals: 18n,
                        baseLTVasCollateral: 7500n,
                        reserveLiquidationThreshold: 8000n,
                        reserveLiquidationBonus: 10500n,
                        reserveFactor: 1000n,
                        usageAsCollateralEnabled: true,
                        borrowingEnabled: true,
                        stableBorrowRateEnabled: false,
                        isActive: true,
                        isFrozen: false,
                        liquidityIndex: 1000000000000000000000000000n,
                        variableBorrowIndex: 1000000000000000000000000000n,
                        liquidityRate: 50000000000000000000000000n, // 5% in Ray (1e27)
                        variableBorrowRate: 789892675294121822070705565n, // triggers uint40 overflow under v3.2 ABI
                        stableBorrowRate: 0n,
                        lastUpdateTimestamp: 1700000000,
                    },
                ],
                {
                    marketReferenceCurrencyUnit: 100000000n,
                    marketReferenceCurrencyPriceInUsd: 100000000n,
                    networkBaseTokenPriceInUsd: 250000000000n,
                    networkBaseTokenPriceDecimals: 8,
                },
            ],
        });

        readContractMock.mockImplementation(async ({ abi }: { abi: typeof aaveUiPoolDataProvider }) => {
            return decodeFunctionResult({
                abi,
                functionName: 'getReservesData',
                data: legacyEncoded,
            });
        });

        const aprs = await aaveOnchainHandler({ markets: [sepoliaMarket] });
        expect(aprs).toEqual([
            {
                address: staticAToken.toLowerCase(),
                apr: 0.05,
            },
        ]);
    });
});

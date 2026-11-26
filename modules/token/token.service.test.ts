import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../../config';
import { prisma } from '../../prisma/prisma-client';
import { prismaTokenFactory } from '../../test/factories/prismaToken.factory';
import { TokenPriceService } from './lib/token-price.service';
import { TokenService } from './token.service';

const nativeLogo =
    'https://raw.githubusercontent.com/frontier-fi/tokenlists/main/src/assets/images/tokens/0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.png';
const wrappedLogo = 'https://coin-images.coingecko.com/coins/images/2518/large/weth.png?1696503332';
const nativeConfig = config.SEPOLIA.eth;

describe('TokenService.getTokenDefinitions native token logos', () => {
    let service: TokenService;

    beforeEach(() => {
        service = new TokenService(new TokenPriceService());
        vi.spyOn(prisma.prismaToken, 'findMany').mockResolvedValue([
            prismaTokenFactory.build({
                address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
                chain: 'SEPOLIA',
                name: 'Wrapped Ether',
                symbol: 'WETH',
                logoURI: wrappedLogo,
            }),
        ]);
        vi.spyOn(prisma.prismaTokenType, 'findMany').mockResolvedValue([]);
        vi.spyOn(prisma.prismaPriceRateProviderData, 'findMany').mockResolvedValue([]);
        vi.spyOn(prisma.prismaErc4626ReviewData, 'findMany').mockResolvedValue([]);
    });

    afterEach(() => {
        config.SEPOLIA.eth = nativeConfig;
        vi.restoreAllMocks();
    });

    it('uses the configured native ETH logo while retaining the WETH logo', async () => {
        const tokens = await service.getTokenDefinitions({ chains: ['SEPOLIA'] });

        expect(tokens).toHaveLength(2);
        expect(
            tokens.find((token) => token.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        ).toMatchObject({ symbol: 'ETH', chain: 'SEPOLIA', logoURI: nativeLogo });
        expect(tokens.find((token) => token.address === '0xfff9976782d46cc05630d1f6ebab18b2324d6b14')).toMatchObject({
            symbol: 'WETH',
            chain: 'SEPOLIA',
            logoURI: wrappedLogo,
        });
    });

    it('falls back to the wrapped-token logo when the native gas token has no configured logo', async () => {
        config.SEPOLIA.eth = {
            address: nativeConfig.address,
            symbol: 'GAS',
            name: 'Native Gas',
        };

        const tokens = await service.getTokenDefinitions({ chains: ['SEPOLIA'] });

        expect(tokens.find((token) => token.address === nativeConfig.address)).toMatchObject({
            symbol: 'GAS',
            name: 'Native Gas',
            logoURI: wrappedLogo,
        });
        expect(tokens.find((token) => token.symbol === 'WETH')?.logoURI).toBe(wrappedLogo);
    });
});

describe('TokenService single-flight and cache consolidation', () => {
    let service: TokenService;

    beforeEach(() => {
        service = new TokenService(new TokenPriceService());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('deduplicates concurrent getTokenDefinitions calls, canonicalizes where keys, and skips failed loads', async () => {
        let failNext = false;
        const token = prismaTokenFactory.build({
            address: '0x00000000000000000000000000000000000000aa',
            chain: 'SEPOLIA',
            symbol: 'TKN',
            name: 'Token',
        });
        const findMany = vi.spyOn(prisma.prismaToken, 'findMany').mockImplementation((async () => {
            await Promise.resolve();
            if (failNext) {
                failNext = false;
                throw new Error('db down');
            }
            return [token];
        }) as any);
        vi.spyOn(prisma.prismaTokenType, 'findMany').mockResolvedValue([]);
        vi.spyOn(prisma.prismaPriceRateProviderData, 'findMany').mockResolvedValue([]);
        vi.spyOn(prisma.prismaErc4626ReviewData, 'findMany').mockResolvedValue([]);

        const results = await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
                service.getTokenDefinitions({
                    chains: ['SEPOLIA'],
                    where: i % 2 === 0 ? { tokensIn: ['0x1'], typeIn: [] } : { typeIn: [], tokensIn: ['0x1'] },
                }),
            ),
        );

        expect(findMany).toHaveBeenCalledTimes(1);
        expect(results.every((result) => result === results[0])).toBe(true);

        // Different args load separately
        await service.getTokenDefinitions({ chains: ['SEPOLIA'] });
        expect(findMany).toHaveBeenCalledTimes(2);

        // Failed load is not cached
        failNext = true;
        await expect(service.getTokenDefinitions({ chains: ['MAINNET'] })).rejects.toThrow('db down');
        const recovered = await service.getTokenDefinitions({ chains: ['MAINNET'] });
        expect(recovered).toHaveLength(1);
        expect(findMany).toHaveBeenCalledTimes(4);
    });

    it('shares one cache entry and single-flights getErc4626Data across concurrent callers', async () => {
        let failNext = false;
        const findReviews = vi.spyOn(prisma.prismaErc4626ReviewData, 'findMany').mockImplementation((async () => {
            await Promise.resolve();
            if (failNext) {
                failNext = false;
                throw new Error('review query failed');
            }
            return [
                {
                    chain: 'SEPOLIA',
                    erc4626Address: '0xvault',
                    assetAddress: '0xasset',
                    name: 'Vault',
                    summary: 'safe',
                    warnings: 'w1,w2',
                    canUseBufferForSwaps: true,
                    useUnderlyingForAddRemove: true,
                    useWrappedForAddRemove: true,
                },
            ];
        }) as any);

        const [a, b] = await Promise.all([service.getErc4626Data(), service.getErc4626Data()]);
        expect(findReviews).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
        expect(a['0xvault-SEPOLIA']?.warnings).toEqual(['w1', 'w2']);

        // Failed load is not cached on a fresh service
        const fresh = new TokenService(new TokenPriceService());
        failNext = true;
        await expect(fresh.getErc4626Data()).rejects.toThrow('review query failed');
        const recovered = await fresh.getErc4626Data();
        expect(recovered['0xvault-SEPOLIA']).toBeDefined();
        expect(findReviews).toHaveBeenCalledTimes(3);
    });

    it('single-flights concurrent getTokens cold loads and does not cache empty results', async () => {
        let nextTokens = [prismaTokenFactory.build({ address: '0xtoken', chain: 'SEPOLIA' })];
        const findMany = vi.spyOn(prisma.prismaToken, 'findMany').mockImplementation((async () => {
            await Promise.resolve();
            return nextTokens;
        }) as any);

        const [first, second] = await Promise.all([service.getTokens('SEPOLIA'), service.getTokens('SEPOLIA')]);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(first).toBe(second);

        // Empty list is not cached
        const fresh = new TokenService(new TokenPriceService());
        nextTokens = [];
        expect(await fresh.getTokens('SEPOLIA')).toEqual([]);
        nextTokens = [prismaTokenFactory.build({ address: '0xtoken2', chain: 'SEPOLIA' })];
        expect(await fresh.getTokens('SEPOLIA')).toHaveLength(1);
        expect(findMany).toHaveBeenCalledTimes(3);
    });

    it('single-flights concurrent getTokenPrices cold loads and does not cache failed loads', async () => {
        const priceService = new TokenPriceService();
        const tokenServiceWithSpy = new TokenService(priceService);
        let failNext = false;
        const getPricesSpy = vi.spyOn(priceService, 'getCurrentTokenPrices').mockImplementation(async () => {
            await Promise.resolve();
            if (failNext) {
                failNext = false;
                throw new Error('prices failed');
            }
            return [{ tokenAddress: '0x1', chain: 'SEPOLIA', price: 1.5 } as any];
        });

        const [p1, p2] = await Promise.all([
            tokenServiceWithSpy.getTokenPrices('SEPOLIA'),
            tokenServiceWithSpy.getTokenPrices('SEPOLIA'),
        ]);
        expect(getPricesSpy).toHaveBeenCalledTimes(1);
        expect(p1).toBe(p2);

        const freshPriceService = new TokenPriceService();
        const freshService = new TokenService(freshPriceService);
        const freshSpy = vi.spyOn(freshPriceService, 'getCurrentTokenPrices').mockRejectedValueOnce(new Error('fail'));
        freshSpy.mockResolvedValueOnce([{ tokenAddress: '0x2', chain: 'SEPOLIA', price: 2 } as any]);

        await expect(freshService.getTokenPrices('SEPOLIA')).rejects.toThrow('fail');
        const recovered = await freshService.getTokenPrices('SEPOLIA');
        expect(recovered).toHaveLength(1);
        expect(freshSpy).toHaveBeenCalledTimes(2);
    });
});

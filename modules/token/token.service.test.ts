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

import { Chain, PrismaToken } from '@prisma/client';
import { prisma } from '../../../prisma/prisma-client';
import { ViemClient } from '../../sources/viem-client';
import { fetchErc4626AndUnderlyingTokenData } from '../../sources/contracts/fetch-erc4626-token-data';

/**
 * Syncs erc4626 tokens and their underlying tokens
 * Only needed to update this info on already created tokens
 */
export const syncErc4626Tokens = async (
    viemClient: ViemClient,
    chain: Chain,
    tokens?: { address: string; decimals: number; name: string; symbol: string; chain: Chain }[],
) => {
    if (!tokens) {
        tokens = await prisma.prismaToken.findMany({
            where: {
                chain,
                address: { not: '0x0000000000000000000000000000000000000000' },
            },
        });
    }

    if (tokens.length === 0) {
        return;
    }

    const enrichedTokensWithErc4626Data = await fetchErc4626AndUnderlyingTokenData(tokens, viemClient);

    const underlyingAddresses = new Set(
        enrichedTokensWithErc4626Data
            .map((token) => token.underlyingTokenAddress)
            .filter((address): address is string => Boolean(address)),
    );

    for (const token of enrichedTokensWithErc4626Data) {
        if (!token.underlyingTokenAddress && !underlyingAddresses.has(token.address)) {
            continue;
        }

        await prisma.prismaToken.upsert({
            where: {
                address_chain: {
                    address: token.address,
                    chain: chain,
                },
            },
            create: {
                ...token,
                chain,
            },
            update: token.underlyingTokenAddress
                ? {
                      ...token,
                  }
                : {},
        });

        if (token.underlyingTokenAddress) {
            await prisma.prismaTokenType.upsert({
                where: {
                    id_chain: {
                        id: `${token.address}-erc4626`,
                        chain,
                    },
                },
                create: {
                    id: `${token.address}-erc4626`,
                    chain,
                    tokenAddress: token.address,
                    type: 'ERC4626',
                },
                update: {
                    id: `${token.address}-erc4626`,
                    chain,
                    tokenAddress: token.address,
                    type: 'ERC4626',
                },
            });
        }
    }
};

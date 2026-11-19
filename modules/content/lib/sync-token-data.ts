import { prisma } from '../../../prisma/prisma-client';
import { chainIdToChain, chainToChainId as chainToIdMap } from '../../../config/chain-id-to-chain';
import { Chain, PrismaTokenTypeOption } from '@prisma/client';
import { contentSources } from '../../../config/content-sources';
import { syncErc4626Tokens } from '../../actions/token/sync-erc4626-tokens';
import { getViemClient } from '../../sources/viem-client';
import config from '../../../config';

interface WhitelistedTokenList {
    name: string;
    timestamp: string;
    tokens: WhitelistedToken[];
}

interface WhitelistedToken {
    chainId: number;
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI: string;
    extensions?: {
        coingeckoId?: string | null;
    };
}

export async function syncTokenContentData(chains: Chain[], filterAddresses?: string[]): Promise<void> {
    const response = await fetch(contentSources.tokenList);
    if (!response.ok) {
        throw new Error(`Failed to fetch token list: ${response.statusText}`);
    }
    const { tokens } = (await response.json()) as WhitelistedTokenList;

    // Validate results
    const requiredKeys = ['chainId', 'address', 'name', 'symbol', 'decimals'];
    const chainIds = chains.map((chain) => Number(chainToIdMap[chain]));
    const allowedAddressSet = filterAddresses ? new Set(filterAddresses.map((addr) => addr.toLowerCase())) : null;
    const upsertTokens = tokens
        .filter(
            (token) =>
                requiredKeys.every((key) => token?.[key as keyof WhitelistedToken] != null) &&
                chainIds.includes(token.chainId) &&
                (!allowedAddressSet || allowedAddressSet.has(token.address.toLowerCase())),
        )
        .map((token) => {
            const chain = chainIdToChain[token.chainId];
            const address = token.address.toLowerCase();
            const isConfiguredWeth = address === config[chain]?.weth.address.toLowerCase();
            const hasExplicitNullCoingeckoId =
                token.extensions !== undefined &&
                Object.hasOwn(token.extensions, 'coingeckoId') &&
                token.extensions.coingeckoId === null;
            const coingeckoTokenId = hasExplicitNullCoingeckoId
                ? null
                : (token.extensions?.coingeckoId ??
                  (isConfiguredWeth ? config[chain]?.coingecko.nativeAssetId : undefined));
            const excludedFromCoingecko = hasExplicitNullCoingeckoId
                ? true
                : typeof token.extensions?.coingeckoId === 'string'
                  ? false
                  : undefined;

            return {
                address,
                chain,
                name: token.name.replace(/[\x00]/g, ''),
                symbol: token.symbol.replace(/[\x00]/g, ''),
                decimals: token.decimals,
                logoURI: token.logoURI,
                coingeckoTokenId,
                ...(excludedFromCoingecko !== undefined ? { excludedFromCoingecko } : {}),
                types: {
                    connectOrCreate: {
                        where: {
                            tokenAddress_type_chain: {
                                tokenAddress: address,
                                type: PrismaTokenTypeOption.WHITE_LISTED,
                                chain,
                            },
                        },
                        create: {
                            id: `${address}-white-listed`,
                            type: PrismaTokenTypeOption.WHITE_LISTED,
                        },
                    },
                },
            };
        });

    const existingTokens =
        !allowedAddressSet && chains.length > 0
            ? await prisma.prismaToken.findMany({
                  where: { chain: { in: chains } },
                  select: { address: true, chain: true },
              })
            : [];
    const existingTokenKeys = new Set(existingTokens.map((token) => `${token.address}-${token.chain}`));

    // Sort deterministically by (chain, address) so concurrent transactions acquire row locks in the same order
    upsertTokens.sort((a, b) => a.chain.localeCompare(b.chain) || a.address.localeCompare(b.address));

    const upserts = upsertTokens.map((token) =>
        prisma.prismaToken.upsert({
            where: {
                address_chain: { address: token.address, chain: token.chain },
            },
            create: token,
            update: token,
        }),
    );

    if (upserts.length > 0) {
        await prisma.$transaction(upserts);
    }

    if (!allowedAddressSet) {
        const newTokens = upsertTokens.filter((token) => !existingTokenKeys.has(`${token.address}-${token.chain}`));
        for (const chain of chains) {
            const newTokensForChain = newTokens
                .filter((token) => token.chain === chain)
                .map(({ address, decimals, name, symbol, chain }) => ({
                    address,
                    decimals,
                    name,
                    symbol,
                    chain,
                }));

            if (newTokensForChain.length > 0) {
                await syncErc4626Tokens(getViemClient(chain), chain, newTokensForChain);
            }
        }
    }

    await syncBlockedTokens();
}

async function syncBlockedTokens() {
    const [existingBlockedTypes, blockedTokensCsv] = await Promise.all([
        prisma.prismaTokenType.findMany({
            select: { id: true, tokenAddress: true, chain: true, type: true },
            where: { type: PrismaTokenTypeOption.BLOCKED_V3 },
        }),
        fetch(contentSources.blockedTokens).then(async (response) => {
            if (!response.ok) {
                throw new Error(`Failed to fetch blocked tokens: ${response.statusText}`);
            }
            return { data: await response.text() };
        }),
    ]);

    const githubBlockedTokens = blockedTokensCsv.data
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
            const [chainId, tokenAddress, protocolVersion] = line.split(',');
            return {
                tokenAddress: tokenAddress?.toLowerCase(),
                chain: chainIdToChain[parseInt(chainId)],
                protocolVersion: parseInt(protocolVersion),
            };
        })
        .filter((token) => token.tokenAddress && token.chain && token.protocolVersion === 3);

    const existingTokensInDB =
        githubBlockedTokens.length > 0
            ? await prisma.prismaToken.findMany({
                  where: {
                      OR: githubBlockedTokens.map((token) => ({
                          address: token.tokenAddress,
                          chain: token.chain,
                      })),
                  },
                  select: { address: true, chain: true },
              })
            : [];

    const tokenExistsInDB = new Set(existingTokensInDB.map((token) => `${token.address}-${token.chain}`));

    const { tokensToAdd, tokensToRemove } = getTokensToSync(
        PrismaTokenTypeOption.BLOCKED_V3,
        githubBlockedTokens,
        existingBlockedTypes,
        tokenExistsInDB,
    );

    const operations = [];

    if (tokensToAdd.length > 0) {
        operations.push(
            prisma.prismaTokenType.createMany({
                skipDuplicates: true,
                data: tokensToAdd,
            }),
        );
    }

    if (tokensToRemove.length > 0) {
        operations.push(
            prisma.prismaTokenType.deleteMany({
                where: { id: { in: tokensToRemove } },
            }),
        );
    }

    if (operations.length > 0) {
        await prisma.$transaction(operations);
    }
}

function getTokensToSync(
    blockType: PrismaTokenTypeOption,
    githubBlockedTokens: {
        tokenAddress: string;
        chain: Chain;
    }[],
    existingBlockedTypes: {
        id: string;
        tokenAddress: string;
        chain: Chain;
        type: PrismaTokenTypeOption;
    }[],
    tokenExistsInDB: Set<string>,
) {
    const tokensToAdd = githubBlockedTokens
        .filter(
            (token) =>
                tokenExistsInDB.has(`${token.tokenAddress}-${token.chain}`) &&
                !existingBlockedTypes.some(
                    (dbToken) =>
                        dbToken.tokenAddress === token.tokenAddress &&
                        dbToken.chain === token.chain &&
                        dbToken.type === blockType,
                ),
        )
        .map((token) => ({
            id: `${token.tokenAddress}-${token.chain}-${blockType}`,
            type: blockType,
            tokenAddress: token.tokenAddress,
            chain: token.chain,
        }));

    const tokensToRemove = existingBlockedTypes
        .filter(
            (dbToken) =>
                dbToken.type === blockType &&
                !githubBlockedTokens.some(
                    (githubToken) =>
                        githubToken.tokenAddress === dbToken.tokenAddress && githubToken.chain === dbToken.chain,
                ),
        )
        .map((dbToken) => dbToken.id);

    return { tokensToAdd, tokensToRemove };
}

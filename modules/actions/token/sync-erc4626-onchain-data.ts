import { Chain } from '@prisma/client';
import { prisma } from '../../../prisma/prisma-client';
import { ViemClient } from '../../sources/types';
import { fetchBufferBalances } from '../../sources/contracts/v3/fetch-buffer-balances';
import { fetchMaxValues } from '../../sources/contracts/v3/fetch-erc4626-max-values';
import { fetchUnwrapRates } from '../../sources/contracts/v3/fetch-unwrap-rates';
import _ from 'lodash';
import { prismaBulkExecuteOperations } from '../../../prisma/prisma-util';
import { syncErc4626Tokens } from './sync-erc4626-tokens';
import { logger } from '../../common/logger';

/**
 * Syncs onchain data for ERC4626 tokens and stores them in the database
 */
export const syncErc4626OnchainData = async (vaultExplorerAddress: string, viemClient: ViemClient, chain: Chain) => {
    const reviewedErc4626 = await prisma.prismaErc4626ReviewData.findMany({
        where: { chain },
        select: { erc4626Address: true, assetAddress: true },
    });

    const candidateAddresses = reviewedErc4626
        .filter((r) => !r.assetAddress || r.erc4626Address.toLowerCase() !== r.assetAddress.toLowerCase())
        .map((r) => r.erc4626Address.toLowerCase());

    if (candidateAddresses.length > 0) {
        const untypedReviewedTokens = await prisma.prismaToken.findMany({
            where: {
                chain,
                address: { in: candidateAddresses },
                OR: [{ underlyingTokenAddress: null }, { types: { none: { type: 'ERC4626' } } }],
            },
        });

        if (untypedReviewedTokens.length > 0) {
            await syncErc4626Tokens(viemClient, chain, untypedReviewedTokens);
        }
    }

    // Get all ERC4626 tokens for the chain
    const erc4626Tokens = await prisma.prismaToken.findMany({
        where: {
            chain,
            types: {
                some: {
                    type: 'ERC4626',
                },
            },
            underlyingTokenAddress: {
                not: null,
            },
        },
    });

    const erc4626TokensMap = Object.fromEntries(erc4626Tokens.map((token) => [token.address, token]));

    if (erc4626Tokens.length === 0) {
        return;
    }

    // Get all underlying tokens for the ERC4626 tokens
    const underlyingTokenAddresses = erc4626Tokens
        .map((token) => token.underlyingTokenAddress)
        .filter((address) => address !== null) as string[];

    const underlyingTokens = await prisma.prismaToken.findMany({
        where: {
            chain,
            address: {
                in: underlyingTokenAddresses,
            },
        },
    });

    // Create a map for quick lookup
    const underlyingTokenMap: { [address: string]: any } = {};
    underlyingTokens.forEach((token) => {
        underlyingTokenMap[token.address] = token;
    });

    try {
        const [maxValues, unwrapRates, bufferBalances] = await Promise.all([
            fetchMaxValues(chain, erc4626Tokens, underlyingTokenMap),
            fetchUnwrapRates(erc4626Tokens, underlyingTokenMap),
            fetchBufferBalances(erc4626Tokens, underlyingTokenMap, vaultExplorerAddress, viemClient),
        ]);

        // Merge onchain data into one object
        const onchainData = _.merge({}, maxValues, unwrapRates, bufferBalances);

        const operations: any[] = [];
        Object.entries(onchainData).map(([tokenAddress, newData]) => {
            // Check if it needs an update
            const currentToken = erc4626TokensMap[tokenAddress];
            const data = {
                ...(newData.bufferBalanceUnderlying &&
                currentToken.bufferBalanceUnderlying !== newData.bufferBalanceUnderlying
                    ? { bufferBalanceUnderlying: newData.bufferBalanceUnderlying }
                    : {}),
                ...(newData.bufferBalanceWrapped && currentToken.bufferBalanceWrapped !== newData.bufferBalanceWrapped
                    ? { bufferBalanceWrapped: newData.bufferBalanceWrapped }
                    : {}),
                ...(currentToken.maxDeposit !== newData.maxDeposit ? { maxDeposit: newData.maxDeposit } : {}),
                ...(currentToken.maxWithdraw !== newData.maxWithdraw ? { maxWithdraw: newData.maxWithdraw } : {}),
                ...(currentToken.unwrapRate !== newData.unwrapRate ? { unwrapRate: newData.unwrapRate } : {}),
            };

            if (Object.keys(data).length > 0) {
                operations.push(
                    prisma.prismaToken.update({
                        where: {
                            address_chain: {
                                address: tokenAddress,
                                chain: chain,
                            },
                        },
                        data,
                    }),
                );
            }
        });

        await prismaBulkExecuteOperations(operations);
    } catch (error) {
        logger.error('Failed to sync ERC4626 on-chain data', { chain, err: error });
        throw error;
    }
};

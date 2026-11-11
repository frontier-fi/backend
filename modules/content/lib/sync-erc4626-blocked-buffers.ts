import { prisma } from '../../../prisma/prisma-client';
import { chainIdToChain } from '../../../config/chain-id-to-chain';
import { contentSources } from '../../../config/content-sources';

/**
 * Runs per configured chain. The blocklist also lists chains this API does not run, and a
 * `chain: undefined` filter would make Prisma update tokens on every chain.
 */
export const syncBlockedBuffers = async (): Promise<void> => {
    const blockedBuffers = await getBlockedBuffers();

    for (const [chainId, chain] of Object.entries(chainIdToChain)) {
        const blockedBuffersForErc4626Addresses = (blockedBuffers[chainId] ?? []).map((address) =>
            address.toLowerCase(),
        );
        const operations = [
            prisma.prismaToken.updateMany({
                where: {
                    chain: chain,
                    isBufferAllowed: false,
                    ...(blockedBuffersForErc4626Addresses.length > 0
                        ? { address: { notIn: blockedBuffersForErc4626Addresses } }
                        : {}),
                },
                data: { isBufferAllowed: true },
            }),
            ...(blockedBuffersForErc4626Addresses.length > 0
                ? [
                      prisma.prismaToken.updateMany({
                          where: {
                              chain: chain,
                              isBufferAllowed: true,
                              address: { in: blockedBuffersForErc4626Addresses },
                          },
                          data: { isBufferAllowed: false },
                      }),
                  ]
                : []),
        ];
        await prisma.$transaction(operations);
    }
};

type BufferBlocklist = {
    [chainId: string]: string[];
};

const getBlockedBuffers = async (): Promise<BufferBlocklist> => {
    const response = await fetch(contentSources.erc4626BufferBlocklist);
    const bufferBlocklist = (await response.json()) as BufferBlocklist;

    return bufferBlocklist;
};

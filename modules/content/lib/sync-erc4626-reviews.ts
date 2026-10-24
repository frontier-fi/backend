import { prisma } from '../../../prisma/prisma-client';
import { githubChainToChain } from './github-helper';
import { contentSources } from '../../../config/content-sources';

export const syncErc4626Reviews = async (): Promise<void> => {
    const erc4626Reviews = await getErc4626Reviews();

    // The registry covers every Balancer chain. Rows for chains we do not run have no enum value.
    const data = erc4626Reviews
        .filter((item) => item.chain !== undefined)
        .map((item) => ({
            chain: item.chain,
            erc4626Address: item.erc4626Address.toLowerCase(),
            name: item.name,
            assetAddress: item.asset.toLowerCase(),
            summary: item.summary,
            canUseBufferForSwaps: item.canUseBufferForSwaps,
            useUnderlyingForAddRemove: item.useUnderlyingForAddRemove,
            useWrappedForAddRemove: item.useWrappedForAddRemove,
            reviewFile: item.review,
            warnings: (item.warnings ?? []).join(','),
        }));

    await prisma.$transaction([
        prisma.prismaErc4626ReviewData.deleteMany(),
        ...(data.length > 0 ? [prisma.prismaErc4626ReviewData.createMany({ data, skipDuplicates: true })] : []),
    ]);
};

interface Erc4626Review {
    [chain: string]: {
        [erc4626Address: string]: {
            name: string;
            asset: string;
            summary: string;
            review: string;
            canUseBufferForSwaps: boolean;
            useUnderlyingForAddRemove: boolean;
            useWrappedForAddRemove: boolean;
            warnings: string[];
        };
    };
}

const getErc4626Reviews = async () => {
    const response = await fetch(contentSources.erc4626Reviews);
    const list = (await response.json()) as Erc4626Review;

    // Flatten the list by adding the chain and erc4626 address to the object
    const erc4626Tokens = Object.keys(list).flatMap((chain) =>
        Object.keys(list[chain]).map((erc4626Address) => ({
            ...list[chain][erc4626Address],
            chain: githubChainToChain[chain],
            erc4626Address,
        })),
    );

    return erc4626Tokens;
};

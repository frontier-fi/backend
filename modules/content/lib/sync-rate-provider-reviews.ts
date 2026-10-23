import { Chain } from '@prisma/client';
import { prisma } from '../../../prisma/prisma-client';
import { normalizeAddress } from '../../web3/addresses';
import { githubChainToChain } from './github-helper';

const RATEPROVIDER_REVIEW_URL =
    'https://raw.githubusercontent.com/balancer/code-review/main/rate-providers/registry.json';

const knownChains = new Set<string>(Object.values(Chain));

export const syncRateProviderReviews = async (): Promise<void> => {
    const rateProviders = await getRateProviderReviews();
    const data = [];
    let skipped = 0;

    for (const item of rateProviders) {
        // The registry covers every Balancer chain. Rows for chains we do not run have no enum value.
        if (!item.chain || !knownChains.has(item.chain)) {
            skipped += 1;
            continue;
        }
        try {
            data.push({
                reviewed: true,
                name: item.name,
                chain: item.chain,
                summary: item.summary,
                tokenAddress: normalizeAddress(item.asset),
                rateProviderAddress: normalizeAddress(item.rateProviderAddress),
                reviewUrl: item.review,
                warnings: (item.warnings ?? []).join(','),
                upgradableComponents: (item.upgradeableComponents ?? []).map((component) => ({
                    entryPoint: component.entrypoint,
                    implementationReviewed: component.implementationReviewed,
                })),
            });
        } catch {
            skipped += 1;
        }
    }

    if (skipped > 0) {
        console.log(`syncRateProviderReviews skipped ${skipped} rows for chains or addresses this API does not use`);
    }

    await prisma.$transaction([
        prisma.prismaPriceRateProviderData.deleteMany(),
        ...(data.length > 0 ? [prisma.prismaPriceRateProviderData.createMany({ data, skipDuplicates: true })] : []),
    ]);
};

interface RateProviderReview {
    [chain: string]: {
        [rateproviderAddress: string]: {
            name: string;
            asset: string;
            summary: string;
            review: string;
            warnings: string[];
            factory: string;
            upgradeableComponents: {
                entrypoint: string;
                implementationReviewed: string;
            }[];
        };
    };
}

const getRateProviderReviews = async () => {
    const response = await fetch(RATEPROVIDER_REVIEW_URL);
    const list = (await response.json()) as RateProviderReview;

    // Flatten the list by adding the chain and rate provider address to the object
    const rateProviders = Object.keys(list).flatMap((chain) =>
        Object.keys(list[chain]).map((rateProviderAddress) => ({
            ...list[chain][rateProviderAddress],
            chain: githubChainToChain[chain],
            rateProviderAddress,
        })),
    );

    return rateProviders;
};

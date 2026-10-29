import _ from 'lodash';
import { roundToHour, roundToMidnight, daysAgo } from '../../common/time';
import { Chain } from '@prisma/client';
import { prisma } from '../../../prisma/prisma-client';
import { JoinExitEvent } from '../../../prisma/prisma-types';

/**
 * Takes join/exit events and enriches them with USD values
 *
 * @param events
 * @param chain
 * @returns
 */
export async function joinExitsUsd(events: JoinExitEvent[], chain: Chain): Promise<JoinExitEvent[]> {
    // Enrich with USD values
    // Group swaps based on timestamp, hourly and daily buckets
    const grouped = _.groupBy(events, (event) => {
        const timestamp = event.blockTimestamp;
        // If swap is older than 30 days, round to midnight
        if (timestamp < daysAgo(30)) {
            return roundToMidnight(timestamp);
        }
        // Otherwise round to the nearest hour
        return roundToHour(timestamp);
    });

    let fallbackPrices: Map<string, number> | undefined;
    const resolvePrice = async (
        tokenPrices: { tokenAddress: string; price: number }[],
        tokenAddress: string,
    ): Promise<number> => {
        const matched = tokenPrices.find((price) => price.tokenAddress.toLowerCase() === tokenAddress.toLowerCase());
        if (matched) return matched.price;

        if (!fallbackPrices) {
            const currentPrices = (await prisma.prismaTokenCurrentPrice?.findMany({ where: { chain } })) || [];
            fallbackPrices = new Map(currentPrices.map((p) => [p.tokenAddress.toLowerCase(), p.price]));
        }
        return fallbackPrices.get(tokenAddress.toLowerCase()) || 0;
    };

    const dbEntries: JoinExitEvent[] = [];
    for (const [timestamp, events] of Object.entries(grouped)) {
        // Calculating USD amounts with token prices at the time of the event
        // 🚨 Reading from the DB in a loop – will get slow with a large events volume
        // But we need prices based on the event timestamp, so batching this should be based on timestamp ranges
        const tokenPrices = await prisma.prismaTokenPrice.findMany({
            where: {
                timestamp: {
                    equals: parseInt(timestamp),
                },
                chain,
            },
        });

        for (const event of events) {
            const tokens = await Promise.all(
                event.payload.tokens.map(async (token) => {
                    const price = await resolvePrice(tokenPrices, token.address);
                    return {
                        ...token,
                        valueUSD: parseFloat(token.amount) * price,
                    };
                }),
            );
            const valueUSD = tokens.reduce((acc, token) => acc + token.valueUSD, 0);

            dbEntries.push({
                ...event,
                valueUSD,
                payload: {
                    tokens,
                },
            });
        }
    }
    return dbEntries;
}

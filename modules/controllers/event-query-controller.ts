import {
    GqlChain,
    GqlPoolAddRemoveEventV3,
    GqlPoolSwapEventV3,
    QueryPoolEventsArgs,
    GqlPoolEventType,
} from '../../apps/api/gql/generated-schema';
import { Chain, PoolEventType } from '@prisma/client';
import { GraphQLError } from 'graphql';
import { JoinExitEvent, SwapEvent } from '../../prisma/prisma-types';
import { eventsRepository } from '../repositories/events';

const parseJoinExit = (event: JoinExitEvent): GqlPoolAddRemoveEventV3 => {
    return {
        __typename: 'GqlPoolAddRemoveEventV3',
        tokens: event.payload.tokens.map((token) => ({
            address: token.address,
            amount: token.amount,
            valueUSD: token.valueUSD,
        })),
        ...event,
        chain: event.chain as GqlChain,
        type: event.type === 'JOIN' ? 'ADD' : 'REMOVE',
        valueUSD: event.valueUSD,
        timestamp: event.blockTimestamp,
        sender: event.userAddress,
    };
};

const parseSwap = (event: SwapEvent): GqlPoolSwapEventV3 => {
    return {
        __typename: 'GqlPoolSwapEventV3',
        ...event,
        chain: event.chain as GqlChain,
        valueUSD: event.valueUSD || 0,
        sender: event.userAddress,
        timestamp: event.blockTimestamp,
        tokenIn: {
            ...event.payload.tokenIn,
            valueUSD: event.valueUSD,
        },
        tokenOut: {
            ...event.payload.tokenOut,
            valueUSD: event.valueUSD,
        },
        fee: {
            ...event.payload.fee,
            valueUSD: Number(event.payload.fee.valueUSD),
        },
    };
};

const GqlTypeToDbType: Record<GqlPoolEventType, PoolEventType> = {
    SWAP: 'SWAP',
    ADD: 'JOIN',
    REMOVE: 'EXIT',
};

export function EventsQueryController(env = process.env) {
    return {
        /**
         * Getting pool events, with pagination and filtering. This is for all vault versions.
         *
         * @param param.first - number of items to return
         * @param param.skip - number of items to skip
         * @param param.where - filtering conditions
         * @returns
         */
        getEvents: async ({
            first,
            skip,
            where,
        }: QueryPoolEventsArgs): Promise<(GqlPoolSwapEventV3 | GqlPoolAddRemoveEventV3)[]> => {
            // Setting default values
            first = Math.min(1000, first ?? 1000); // Limiting to 1000 items
            skip = skip ?? 0;
            let { chainIn, poolIdIn, poolId, type, typeIn, userAddress } = where || {};

            if (!chainIn || chainIn.length === 0) {
                return [];
            }

            // Table is partitioned by chain, so querying by many chains is extremely inefficient.
            // Reject instead of silently returning events for the first chain only.
            if (new Set(chainIn).size > 1) {
                throw new GraphQLError('poolEvents supports one chain per request. Query each chain separately.', {
                    extensions: { code: 'BAD_USER_INPUT' },
                });
            }

            const mappedTypeIn = typeIn?.filter((t): t is GqlPoolEventType => !!t).map((t) => GqlTypeToDbType[t]);
            const cleanPoolIdIn = poolIdIn?.filter((id): id is string => !!id);

            const conditions = {
                chain: chainIn[0] as Chain,
                ...(mappedTypeIn && mappedTypeIn.length === 1
                    ? { eventType: mappedTypeIn[0] }
                    : mappedTypeIn && mappedTypeIn.length > 1
                      ? { eventTypeIn: mappedTypeIn }
                      : {}),
                ...(cleanPoolIdIn && cleanPoolIdIn.length === 1
                    ? { poolId: cleanPoolIdIn[0] }
                    : cleanPoolIdIn && cleanPoolIdIn.length > 1
                      ? { poolIdIn: cleanPoolIdIn }
                      : {}),
                ...(poolId ? { poolId: poolId } : {}),
                ...(type ? { eventType: GqlTypeToDbType[type] } : {}),
                userAddress: userAddress || undefined,
            };

            const dbEvents = await eventsRepository.getEvents({
                ...conditions,
                limit: first,
                offset: skip,
            });

            const results = dbEvents.map((event) =>
                event.type === 'SWAP' ? parseSwap(event as SwapEvent) : parseJoinExit(event as JoinExitEvent),
            );

            return results;
        },
    };
}

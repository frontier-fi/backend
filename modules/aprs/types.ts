import { PrismaPoolAprItem, PrismaPoolAprType } from '@prisma/client';
import type { PoolAPRData } from './apr-repository';
export type { PoolAPRData };

export interface AprPreservationRule {
    poolId: string;
    /** Optional APR item ID prefix. When set, only existing items for `poolId` whose ID starts with this prefix are preserved. */
    idPrefix?: string;
    /** Optional exact item IDs to exclude from preservation (e.g. opportunities already returned under another prefix on this run). */
    excludeIds?: ReadonlySet<string>;
}

export interface AprCalculationResult {
    items: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[];
    /**
     * Existing DB APR items to preserve rather than prune when part of this handler's calculation failed.
     * All other items and newly calculated items are still applied.
     */
    preserveItems?: readonly AprPreservationRule[];
}

export interface AprHandler {
    /**
     * Calculate APR for the given pools
     * @param pools Array of pools to calculate APR for
     * @returns Array of APR items ready to be saved (without createdAt/updatedAt)
     */
    calculateAprForPools(pools: PoolAPRData[]): Promise<Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[]>;

    /**
     * Optional extended calculation returning per-pool partial failures alongside calculated items.
     */
    calculateAprForPoolsWithFailures?(pools: PoolAPRData[]): Promise<AprCalculationResult>;

    /**
     * Get the APR item types owned by this handler.
     */
    getAprTypes(): PrismaPoolAprType[];

    /**
     * Get the name of this calculator
     */
    getAprServiceName(): string;
}

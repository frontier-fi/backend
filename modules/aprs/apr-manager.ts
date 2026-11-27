import { Chain, PrismaPoolAprItem, PrismaPoolAprType } from '@prisma/client';
import { AprHandler, AprPreservationRule } from './types';
import { AprRepository } from './apr-repository';
import _ from 'lodash';
import { logger } from '../common/logger';

export class AprManager {
    constructor(
        private readonly aprRepository: AprRepository,
        private readonly aprHandlers: AprHandler[],
    ) {}

    private async calculateAprsWithFailures(
        chain: Chain,
        poolIds?: string[],
    ): Promise<{
        aprItems: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[];
        failedTypes: Set<PrismaPoolAprType>;
        preserveItemsByType: Map<PrismaPoolAprType, AprPreservationRule[]>;
    }> {
        const pools = await this.aprRepository.getPoolsForAprCalculation(chain, poolIds);

        if (pools.length === 0) {
            return { aprItems: [], failedTypes: new Set(), preserveItemsByType: new Map() };
        }

        // Get all APR items from all handlers
        const allAprItems: Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[] = [];
        const failedTypes = new Set<PrismaPoolAprType>();
        const preserveItemsByType = new Map<PrismaPoolAprType, AprPreservationRule[]>();

        for (const handler of this.aprHandlers) {
            try {
                const result = handler.calculateAprForPoolsWithFailures
                    ? await handler.calculateAprForPoolsWithFailures(pools)
                    : { items: await handler.calculateAprForPools(pools) };
                allAprItems.push(...result.items);
                if (result.preserveItems && result.preserveItems.length > 0) {
                    for (const type of handler.getAprTypes()) {
                        let rules = preserveItemsByType.get(type);
                        if (!rules) {
                            rules = [];
                            preserveItemsByType.set(type, rules);
                        }
                        rules.push(...result.preserveItems);
                    }
                }
            } catch (e: any) {
                logger.error('APR handler failed', { handler: handler.getAprServiceName(), err: e });
                for (const type of handler.getAprTypes()) {
                    failedTypes.add(type);
                }
            }
        }

        return { aprItems: allAprItems, failedTypes, preserveItemsByType };
    }

    /**
     * Calculate APRs without writing to the database
     */
    async calculateAprs(
        chain: Chain,
        poolIds?: string[],
    ): Promise<Omit<PrismaPoolAprItem, 'createdAt' | 'updatedAt'>[]> {
        const { aprItems } = await this.calculateAprsWithFailures(chain, poolIds);
        return aprItems;
    }

    /**
     * Calculate and persist APRs
     */
    async updateAprs(chain: Chain, poolIds?: string[]): Promise<string[]> {
        const { aprItems, failedTypes, preserveItemsByType } = await this.calculateAprsWithFailures(chain, poolIds);
        const changedPoolIds = await this.aprRepository.savePoolAprItems(chain, aprItems, poolIds, {
            preserveTypes: failedTypes,
            preserveItemsByType,
        });

        if (changedPoolIds.length > 0) {
            await this.aprRepository.updatePoolTotalApr(chain, changedPoolIds);
        }

        return changedPoolIds;
    }

    /**
     * Reload all APRs for a chain (deletes existing data first)
     * @returns Update statistics
     */
    async reloadAllPoolAprs(chain: Chain): Promise<string[]> {
        await this.aprRepository.deleteAllPoolAprItems(chain);
        return this.updateAprs(chain);
    }
}

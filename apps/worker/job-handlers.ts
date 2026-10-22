import * as Sentry from '@sentry/node';
import { Express, NextFunction } from 'express';
import { tokenService } from '../../modules/token/token.service';
import { PricingService } from '../../modules/pricing/pricing-service';
import moment from 'moment';
import { chainIdToChain } from '../../config/chain-id-to-chain';
import { Chain } from '@prisma/client';
import {
    SnapshotsController,
    PoolController,
    EventController,
    TokenYieldsController,
} from '../../modules/controllers';
import { updateVolumeAndFees } from '../../modules/actions/pool/update-volume-and-fees';
import { TokenController } from '../../modules/controllers/token-controller';
import config from '../../config';
import { AprsController } from '../../modules/controllers/aprs-controller';
import { ContentController } from '../../modules/content/content-controller';
import { UserBalancesController } from '../../modules/user/user-balances-controller';

const runningJobs: Set<string> = new Set();

async function runIfNotAlreadyRunning(
    id: string,
    chainId: string,
    fn: () => any,
    res: any,
    next: NextFunction,
): Promise<void> {
    const jobId = `${id}-${chainId}`;

    if (runningJobs.has(jobId)) {
        console.log(`Skip job ${jobId}-skip`);
        res.sendStatus(200);
        return;
    }

    const startJobTime = moment();

    try {
        runningJobs.add(jobId);

        console.log(`Start job ${jobId}-start`);

        await fn();

        const durationSuccess = moment.duration(moment().diff(startJobTime)).asSeconds();
        console.log(`Successful job ${jobId}-done`, durationSuccess);
    } catch (error: any) {
        const duration = moment.duration(moment().diff(startJobTime)).asSeconds();
        console.log(`Error job ${jobId}-error`, duration, error.message || error);
        next(error);
    } finally {
        runningJobs.delete(jobId);
        res.sendStatus(200);
    }
}

export function configureWorkerRoutes(app: Express) {
    app.post('/', async (req, res, next) => {
        Sentry.withIsolationScope(async (scope) => {
            const job = req.body as { name: string; chain: string };
            const sentryTransactionName = `${job.name}-${job.chain}`;

            // Clear breadcrumbs to avoid mixing them between requests
            // That doesn't always work, but it's better than nothing
            scope.clearBreadcrumbs();
            scope.setTransactionName(sentryTransactionName);
            scope.setTag('job', job.name);
            scope.setTag('chain', job.chain);

            // Start profiling span for the job
            Sentry.startSpan({ op: 'job', name: sentryTransactionName }, () => {
                setupJobHandlers(job.name, job.chain, res, next);
            });
        });
    });
}

const setupJobHandlers = async (name: string, chainId: string, res: any, next: NextFunction) => {
    const chain = chainIdToChain[chainId];
    switch (name) {
        case 'user-sync-wallet-balances-for-all-pools':
            await runIfNotAlreadyRunning(name, chainId, () => UserBalancesController().syncBalances(chain), res, next);
            break;
        case 'update-token-prices':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                async () => {
                    const chains = Object.keys(config) as Chain[];
                    const service = new PricingService(chains);
                    const errors: Error[] = [];
                    for (const chain of chains) {
                        try {
                            await service.updatePrices(chain);
                        } catch (error) {
                            console.log(`Error updating prices for chain ${chain}:`, error);
                            errors.push(error instanceof Error ? error : new Error(`Unknown error: ${error}`));
                        }
                    }
                    if (errors.length > 0) {
                        throw new Error(errors.map((e) => e.message).join(', '));
                    }
                    return 'OK';
                },
                res,
                next,
            );
            break;
        case 'update-liquidity-for-inactive-pools':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => PoolController().updateLiquidityValuesForInactivePools(chain),
                res,
                next,
            );
            break;
        case 'sync-token-content-data':
            await runIfNotAlreadyRunning(name, chainId, () => ContentController().syncTokenContentData(), res, next);
            break;
        case 'sync-snapshots':
            await runIfNotAlreadyRunning(name, chainId, () => SnapshotsController().syncSnapshots(chain), res, next);
            break;
        case 'global-purge-old-tokenprices':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => tokenService.purgeOldTokenPricesForAllChains(),
                res,
                next,
            );
            break;
        case 'update-fee-volume-yield-all-pools':
            await runIfNotAlreadyRunning(name, chainId, () => updateVolumeAndFees(chain), res, next);
            break;
        // APRs
        case 'update-pool-apr':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => {
                    const chain = chainIdToChain[chainId];
                    return AprsController().updateAprsAndIncentivizedCategory(chain);
                },
                res,
                next,
            );
            break;
        // V3 Jobs
        case 'add-pools-v3':
            await runIfNotAlreadyRunning(name, chainId, () => PoolController().addPoolsV3(chain), res, next);
            break;
        case 'sync-pools-v3':
            await runIfNotAlreadyRunning(name, chainId, () => PoolController().syncPoolsV3(chain), res, next);
            break;
        case 'sync-hook-data':
            await runIfNotAlreadyRunning(name, chainId, () => PoolController().syncHookData(chain), res, next);
            break;
        case 'sync-swaps-v3':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => EventController().syncSwapsUpdateVolumeAndFeesV3(chain),
                res,
                next,
            );
            break;
        case 'sync-join-exits-v3':
            await runIfNotAlreadyRunning(name, chainId, () => EventController().syncJoinExitsV3(chain), res, next);
            break;
        case 'update-liquidity-24h-ago-v3':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => PoolController().updateLiquidity24hAgoV3(chain),
                res,
                next,
            );
            break;
        case 'sync-categories':
            await runIfNotAlreadyRunning(name, chainId, () => ContentController().syncCategories(), res, next);
            break;
        case 'sync-rate-provider-reviews':
            await runIfNotAlreadyRunning(name, chainId, () => ContentController().syncRateProviderReviews(), res, next);
            break;
        case 'sync-hook-reviews':
            await runIfNotAlreadyRunning(name, chainId, () => ContentController().syncHookReviews(), res, next);
            break;
        case 'sync-erc4626-data':
            await runIfNotAlreadyRunning(name, chainId, () => ContentController().syncErc4626Data(), res, next);
            break;
        case 'sync-erc4626-onchain-data':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => TokenController().syncErc4626OnChainData(chain),
                res,
                next,
            );
            break;
        case 'sync-token-tvl':
            await runIfNotAlreadyRunning(name, chainId, () => TokenController().syncTvl(), res, next);
            break;
        case 'fetch-token-yields':
            await runIfNotAlreadyRunning(
                name,
                chainId,
                () => TokenYieldsController().fetchAndStoreAllYields(),
                res,
                next,
            );
            break;
        case 'update-lifetime-values':
            await runIfNotAlreadyRunning(name, chainId, () => PoolController().updateLifeTimeValues(chain), res, next);
            break;
        default:
            res.sendStatus(400);
            // throw new Error(`Unhandled job type ${name}`);
            console.log(`Unhandled job type ${name}`);
    }
};

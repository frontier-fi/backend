import { Express } from 'express';
import { Chain } from '@prisma/client';
import { tokenService } from '../../modules/token/token.service';
import { PricingService } from '../../modules/pricing/pricing-service';
import { chainIdToChain } from '../../config/chain-id-to-chain';
import { SnapshotsController, PoolController, EventController, TokenYieldsController } from '../../modules/controllers';
import { updateVolumeAndFees } from '../../modules/actions/pool/update-volume-and-fees';
import { TokenController } from '../../modules/controllers/token-controller';
import config from '../../config';
import { AprsController } from '../../modules/controllers/aprs-controller';
import { ContentController } from '../../modules/content/content-controller';
import { UserBalancesController } from '../../modules/user/user-balances-controller';

export type JobHandler = (chain: Chain) => Promise<unknown>;

export interface JobOutcome {
    job: string;
    status: 'done' | 'failed' | 'skipped';
    durationSeconds?: number;
    error?: string;
}

async function updateTokenPricesForAllChains(): Promise<void> {
    const chains = Object.keys(config) as Chain[];
    const service = new PricingService(chains);
    const errors: Error[] = [];
    for (const chain of chains) {
        try {
            await service.updatePrices(chain);
        } catch (error) {
            console.error(`Error updating prices for chain ${chain}:`, error);
            errors.push(error instanceof Error ? error : new Error(`Unknown error: ${error}`));
        }
    }
    if (errors.length > 0) {
        throw new Error(errors.map((e) => e.message).join(', '));
    }
}

export const jobHandlers: Record<string, JobHandler> = {
    'add-pools-v3': (chain) => PoolController().addPoolsV3(chain),
    'sync-pools-v3': (chain) => PoolController().syncPoolsV3(chain),
    'sync-join-exits-v3': (chain) => EventController().syncJoinExitsV3(chain),
    'sync-swaps-v3': (chain) => EventController().syncSwapsUpdateVolumeAndFeesV3(chain),
    'sync-hook-data': (chain) => PoolController().syncHookData(chain),
    'update-liquidity-24h-ago-v3': (chain) => PoolController().updateLiquidity24hAgoV3(chain),
    'update-liquidity-for-inactive-pools': (chain) => PoolController().updateLiquidityValuesForInactivePools(chain),
    'sync-snapshots': (chain) => SnapshotsController().syncSnapshots(chain),
    'user-sync-wallet-balances-for-all-pools': (chain) => UserBalancesController().syncBalances(chain),
    'update-fee-volume-yield-all-pools': (chain) => updateVolumeAndFees(chain),
    'update-pool-apr': (chain) => AprsController().updateAprsAndIncentivizedCategory(chain),
    'sync-erc4626-onchain-data': (chain) => TokenController().syncErc4626OnChainData(chain),
    'update-lifetime-values': (chain) => PoolController().updateLifeTimeValues(chain),
    'update-token-prices': () => updateTokenPricesForAllChains(),
    'global-purge-old-tokenprices': () => tokenService.purgeOldTokenPricesForAllChains(),
    'sync-rate-provider-reviews': () => ContentController().syncRateProviderReviews(),
    'sync-erc4626-data': () => ContentController().syncErc4626Data(),
    'fetch-token-yields': () => TokenYieldsController().fetchAndStoreAllYields(),
    'sync-categories': () => ContentController().syncCategories(),
    'sync-token-tvl': () => TokenController().syncTvl(),
    'sync-token-content-data': () => ContentController().syncTokenContentData(),
};

const runningJobs = new Map<string, Promise<JobOutcome>>();

function runIfNotAlreadyRunning(jobId: string, fn: () => Promise<unknown>): Promise<JobOutcome> {
    if (runningJobs.has(jobId)) {
        console.log(`Skip job ${jobId}-skip`);
        return Promise.resolve({ job: jobId, status: 'skipped' });
    }

    const run = runJob(jobId, fn).finally(() => runningJobs.delete(jobId));
    runningJobs.set(jobId, run);
    return run;
}

async function runJob(jobId: string, fn: () => Promise<unknown>): Promise<JobOutcome> {
    const startedAt = Date.now();

    try {
        console.log(`Start job ${jobId}-start`);

        await fn();

        const duration = (Date.now() - startedAt) / 1000;
        console.log(`Successful job ${jobId}-done`, duration);
        return { job: jobId, status: 'done', durationSeconds: duration };
    } catch (error: unknown) {
        const duration = (Date.now() - startedAt) / 1000;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error job ${jobId}-error`, duration, error);
        return { job: jobId, status: 'failed', durationSeconds: duration, error: message };
    }
}

export interface WorkerRoutes {
    /** Refuses new jobs, then waits up to timeoutMs for the running ones. Resolves with those still running. */
    drain(timeoutMs: number): Promise<string[]>;
}

/**
 * POST / runs one job and answers with its outcome once it ends. The status is 200 whenever
 * the job was accepted, also when it failed: the failure is logged to stderr for Better Stack.
 */
export function configureWorkerRoutes(app: Express, handlers: Record<string, JobHandler> = jobHandlers): WorkerRoutes {
    let draining = false;

    app.get('/health', (_req, res) => {
        res.sendStatus(200);
    });

    app.post('/', async (req, res) => {
        if (draining) {
            res.sendStatus(503);
            return;
        }

        const { name, chain: chainId } = (req.body ?? {}) as { name?: unknown; chain?: unknown };
        if (
            typeof name !== 'string' ||
            typeof chainId !== 'string' ||
            !Object.hasOwn(handlers, name) ||
            !Object.hasOwn(chainIdToChain, chainId)
        ) {
            console.error(`Unhandled job ${String(name)} for chain ${String(chainId)}`);
            res.sendStatus(400);
            return;
        }

        const handler = handlers[name];
        const chain = chainIdToChain[chainId];
        const jobId = `${name}-${chainId}`;

        const outcome = await runIfNotAlreadyRunning(jobId, () => handler(chain));

        res.json(outcome);
    });

    return {
        async drain(timeoutMs) {
            draining = true;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            });
            try {
                await Promise.race([Promise.allSettled(runningJobs.values()), deadline]);
            } finally {
                clearTimeout(timer);
            }
            return [...runningJobs.keys()];
        },
    };
}

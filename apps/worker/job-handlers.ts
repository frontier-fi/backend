import { Express } from 'express';
import { Chain, PrismaClient } from '@prisma/client';
import murmurhash from 'murmurhash';
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
import { env } from '../env';
import { withDefaultConnectionParams } from '../../prisma/prisma-client';

export type JobHandler = (chain: Chain) => Promise<unknown>;

export interface JobOutcome {
    job: string;
    status: 'done' | 'failed' | 'skipped';
    durationSeconds?: number;
    error?: string;
    reason?: string;
}

/** A job outcome plus the stack of a failure, which is logged but not sent back to the scheduler. */
type JobResult = JobOutcome & { stack?: string };

function errorFields(error: unknown, prefix?: string): Pick<JobResult, 'error' | 'stack'> {
    const message = error instanceof Error ? error.message : String(error);
    return {
        error: prefix ? `${prefix}: ${message}` : message,
        stack: error instanceof Error ? error.stack : undefined,
    };
}

const MAX_LOG_ERROR_CHARS = 500;
const MAX_LOG_STACK_CHARS = 700;

// RPC errors from viem quote the request URL, and dRPC URLs carry the API key in the path.
function redactSecrets(text: string): string {
    return env.DRPC_API_KEY ? text.split(env.DRPC_API_KEY).join('***') : text;
}

function capText(text: string, maxChars: number): string {
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Logs one JSON line per job so Better Stack can filter and alert on name, chain and status.
 * Indexing fields come first and error/stack are capped so DigitalOcean's 2 KB syslog limit
 * never truncates the JSON object. Failures go to stderr.
 */
function logJobResult(name: string, chain: Chain, { stack, ...outcome }: JobResult): JobOutcome {
    if (outcome.error) {
        outcome.error = redactSecrets(outcome.error);
    }
    const line = JSON.stringify({
        level: outcome.status === 'failed' ? 'error' : 'info',
        job: outcome.job,
        name,
        chain,
        status: outcome.status,
        durationSeconds: outcome.durationSeconds,
        reason: outcome.reason,
        error: outcome.error && capText(outcome.error, MAX_LOG_ERROR_CHARS),
        stack: stack && capText(redactSecrets(stack), MAX_LOG_STACK_CHARS),
    });
    if (outcome.status === 'failed') {
        console.error(line);
    } else {
        console.log(line);
    }
    return outcome;
}

export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;

export type LockAcquireFn = (jobId: string) => Promise<(() => Promise<void>) | null>;

let lockPrismaClient: PrismaClient | undefined;

function getLockPrismaClient(): PrismaClient {
    if (!lockPrismaClient) {
        // Dedicated single-connection client so session-level pg_try_advisory_lock and
        // pg_advisory_unlock always execute on the exact same PostgreSQL backend connection.
        lockPrismaClient = new PrismaClient({
            datasources: {
                db: {
                    url: withDefaultConnectionParams(env.DATABASE_URL, 1, 15),
                },
            },
        });
    }
    return lockPrismaClient;
}

export async function acquirePostgresAdvisoryLock(
    jobId: string,
    client: Pick<PrismaClient, '$queryRaw' | '$executeRaw'> = getLockPrismaClient(),
): Promise<(() => Promise<void>) | null> {
    const lockKey = murmurhash.v3(jobId);
    const rows = await client.$queryRaw<
        { locked: boolean }[]
    >`SELECT pg_try_advisory_lock(${lockKey}::bigint) AS locked`;
    if (!rows[0]?.locked) {
        return null;
    }
    return async () => {
        try {
            await client.$executeRaw`SELECT pg_advisory_unlock(${lockKey}::bigint)`;
        } catch (error) {
            console.error(`Failed to release advisory lock for ${jobId}:`, error);
        }
    };
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

const runningJobs = new Map<string, Promise<JobResult>>();

export interface WorkerRouteOptions {
    jobTimeoutMs?: number;
    acquireLock?: LockAcquireFn;
}

function runIfNotAlreadyRunning(
    jobId: string,
    fn: () => Promise<unknown>,
    options: Required<WorkerRouteOptions>,
): Promise<JobResult> {
    if (runningJobs.has(jobId)) {
        return Promise.resolve({ job: jobId, status: 'skipped', reason: 'already running' });
    }

    const run = runJob(jobId, fn, options).finally(() => runningJobs.delete(jobId));
    runningJobs.set(jobId, run);
    return run;
}

async function runJob(
    jobId: string,
    fn: () => Promise<unknown>,
    options: Required<WorkerRouteOptions>,
): Promise<JobResult> {
    let releaseLock: (() => Promise<void>) | null = null;
    try {
        releaseLock = await options.acquireLock(jobId);
    } catch (error) {
        return {
            job: jobId,
            status: 'failed',
            durationSeconds: 0,
            ...errorFields(error, 'Failed to acquire advisory lock'),
        };
    }

    if (!releaseLock) {
        return { job: jobId, status: 'skipped', reason: 'locked by another worker' };
    }

    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Job ${jobId} timed out after ${options.jobTimeoutMs}ms`));
            }, options.jobTimeoutMs);
        });

        await Promise.race([fn(), timeoutPromise]);

        const duration = (Date.now() - startedAt) / 1000;
        return { job: jobId, status: 'done', durationSeconds: duration };
    } catch (error: unknown) {
        const duration = (Date.now() - startedAt) / 1000;
        return { job: jobId, status: 'failed', durationSeconds: duration, ...errorFields(error) };
    } finally {
        clearTimeout(timer);
        await releaseLock();
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
export function configureWorkerRoutes(
    app: Express,
    handlers: Record<string, JobHandler> = jobHandlers,
    options: WorkerRouteOptions = {},
): WorkerRoutes {
    let draining = false;
    const resolvedOptions: Required<WorkerRouteOptions> = {
        jobTimeoutMs: options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
        acquireLock: options.acquireLock ?? acquirePostgresAdvisoryLock,
    };

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

        const result = await runIfNotAlreadyRunning(jobId, () => handler(chain), resolvedOptions);

        res.json(logJobResult(name, chain, result));
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
            if (lockPrismaClient) {
                await lockPrismaClient.$disconnect().catch(() => undefined);
                lockPrismaClient = undefined;
            }
            return [...runningJobs.keys()];
        },
    };
}

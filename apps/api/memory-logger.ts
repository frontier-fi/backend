import { logger } from '../../modules/common/logger';
import type { EdgeCacheStats } from './apollo/edge';

export const MEMORY_LOG_INTERVAL_MS = 10 * 60 * 1000;

export interface MemoryStatsSources {
    documentStore: { entries: number; bytes: number };
    apolloCache: { entries: number; bytes: number };
    getEdgeStats?: () => EdgeCacheStats;
    intervalMs?: number;
    memoryUsage?: () => NodeJS.MemoryUsage;
}

const toMb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

/** Logs process memory footprint alongside Apollo and edge cache utilization. */
export function logMemoryUsage(sources: MemoryStatsSources): void {
    const { rss, heapTotal, heapUsed, external, arrayBuffers } = (sources.memoryUsage ?? process.memoryUsage)();
    const edgeStats = sources.getEdgeStats?.();

    logger.info('Process memory usage', {
        event: 'memory-stats',
        rssMb: toMb(rss),
        heapTotalMb: toMb(heapTotal),
        heapUsedMb: toMb(heapUsed),
        externalMb: toMb(external),
        arrayBuffersMb: toMb(arrayBuffers),
        documentStoreEntries: sources.documentStore.entries,
        documentStoreKb: Math.round(sources.documentStore.bytes / 1024),
        apolloCacheEntries: sources.apolloCache.entries,
        apolloCacheKb: Math.round(sources.apolloCache.bytes / 1024),
        ...(edgeStats
            ? {
                  responseCacheEntries: edgeStats.responseCacheEntries,
                  responseCacheKb: Math.round(edgeStats.responseCacheBytes / 1024),
                  rateLimitBuckets: edgeStats.rateLimitBuckets,
              }
            : {}),
    });
}

/** Schedules periodic memory telemetry on an unref'd timer and returns a stop callback. */
export function startMemoryLogging(sources: MemoryStatsSources): () => void {
    const timer = setInterval(() => logMemoryUsage(sources), sources.intervalMs ?? MEMORY_LOG_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}

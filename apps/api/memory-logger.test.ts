import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../modules/common/logger';
import { logMemoryUsage, MEMORY_LOG_INTERVAL_MS, startMemoryLogging } from './memory-logger';

describe('memory-logger', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('logs process memory and cache metrics with and without edge stats', () => {
        const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
        const memoryUsage = () => ({
            rss: 256 * 1024 * 1024,
            heapTotal: 128 * 1024 * 1024,
            heapUsed: 96 * 1024 * 1024,
            external: 12 * 1024 * 1024,
            arrayBuffers: 4 * 1024 * 1024,
        });

        logMemoryUsage({
            documentStore: { entries: 12, bytes: 24 * 1024 },
            apolloCache: { entries: 3, bytes: 6 * 1024 },
            memoryUsage,
        });

        expect(infoSpy).toHaveBeenCalledWith('Process memory usage', {
            event: 'memory-stats',
            rssMb: 256,
            heapTotalMb: 128,
            heapUsedMb: 96,
            externalMb: 12,
            arrayBuffersMb: 4,
            documentStoreEntries: 12,
            documentStoreKb: 24,
            apolloCacheEntries: 3,
            apolloCacheKb: 6,
        });

        logMemoryUsage({
            documentStore: { entries: 12, bytes: 24 * 1024 },
            apolloCache: { entries: 3, bytes: 6 * 1024 },
            getEdgeStats: () => ({
                responseCacheEntries: 40,
                responseCacheBytes: 512 * 1024,
                rateLimitBuckets: 7,
                inFlightRequests: 1,
            }),
            memoryUsage,
        });

        expect(infoSpy).toHaveBeenLastCalledWith('Process memory usage', {
            event: 'memory-stats',
            rssMb: 256,
            heapTotalMb: 128,
            heapUsedMb: 96,
            externalMb: 12,
            arrayBuffersMb: 4,
            documentStoreEntries: 12,
            documentStoreKb: 24,
            apolloCacheEntries: 3,
            apolloCacheKb: 6,
            responseCacheEntries: 40,
            responseCacheKb: 512,
            rateLimitBuckets: 7,
        });
    });

    it('emits on the configured interval and stops cleanly on cleanup', () => {
        vi.useFakeTimers();
        const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

        const stop = startMemoryLogging({
            documentStore: { entries: 1, bytes: 1024 },
            apolloCache: { entries: 0, bytes: 0 },
            memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
        });

        vi.advanceTimersByTime(MEMORY_LOG_INTERVAL_MS);
        expect(infoSpy).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(MEMORY_LOG_INTERVAL_MS);
        expect(infoSpy).toHaveBeenCalledTimes(2);

        stop();
        vi.advanceTimersByTime(MEMORY_LOG_INTERVAL_MS * 3);
        expect(infoSpy).toHaveBeenCalledTimes(2);
    });
});

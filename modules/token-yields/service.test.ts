import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenYieldAprHandlers } from './handlers';
import { TokenYieldRepository } from './repository';
import { STALE_TOKEN_YIELD_TTL_MS, TokenYieldsService } from './service';
import { logger } from '../common/logger';

describe('TokenYieldsService', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('stores valid yields, skips non-finite APRs, and prunes stale yields older than 24h', async () => {
        const now = new Date('2026-11-27T15:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(now);

        vi.spyOn(TokenYieldAprHandlers.prototype, 'fetchAprsFromAllHandlers').mockResolvedValue([
            { address: '0xvalid', chain: 'MAINNET', source: 'http', apr: 0.03 },
            { address: '0xnan', chain: 'MAINNET', source: 'http', apr: Number.NaN },
        ]);

        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

        const repository = {
            storeTokenYields: vi.fn().mockResolvedValue(undefined),
            deleteStaleTokenYields: vi.fn().mockResolvedValue(546),
        } as unknown as TokenYieldRepository;

        const service = new TokenYieldsService(repository);
        await service.fetchAndStoreYields({}, 'MAINNET');

        expect(warnSpy).toHaveBeenCalledWith('Skipped non-finite token yield APR', {
            chain: 'MAINNET',
            tokenAddress: '0xnan',
            apr: 'NaN',
        });
        expect(repository.storeTokenYields).toHaveBeenCalledWith('MAINNET', [
            { address: '0xvalid', chain: 'MAINNET', source: 'http', apr: 0.03 },
        ]);
        expect(repository.deleteStaleTokenYields).toHaveBeenCalledWith(
            'MAINNET',
            new Date(now.getTime() - STALE_TOKEN_YIELD_TTL_MS),
        );
        expect(infoSpy).toHaveBeenCalledWith('Pruned stale token yields', {
            chain: 'MAINNET',
            deletedCount: 546,
        });
    });

    it('does not log when no stale token yields were pruned', async () => {
        vi.spyOn(TokenYieldAprHandlers.prototype, 'fetchAprsFromAllHandlers').mockResolvedValue([
            { address: '0xvalid', chain: 'MONAD', source: 'http', apr: 0.05 },
        ]);

        const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
        const repository = {
            storeTokenYields: vi.fn().mockResolvedValue(undefined),
            deleteStaleTokenYields: vi.fn().mockResolvedValue(0),
        } as unknown as TokenYieldRepository;

        const service = new TokenYieldsService(repository);
        await service.fetchAndStoreYields({}, 'MONAD');

        expect(repository.deleteStaleTokenYields).toHaveBeenCalledOnce();
        expect(infoSpy).not.toHaveBeenCalled();
    });

    it('does not store or prune when all fetched APRs are non-finite or empty', async () => {
        const fetchSpy = vi.spyOn(TokenYieldAprHandlers.prototype, 'fetchAprsFromAllHandlers');
        vi.spyOn(logger, 'warn').mockImplementation(() => {});

        const repository = {
            storeTokenYields: vi.fn().mockResolvedValue(undefined),
            deleteStaleTokenYields: vi.fn().mockResolvedValue(0),
        } as unknown as TokenYieldRepository;

        const service = new TokenYieldsService(repository);

        fetchSpy.mockResolvedValueOnce([]);
        await service.fetchAndStoreYields({}, 'MAINNET');

        fetchSpy.mockResolvedValueOnce([{ address: '0xnan', chain: 'MAINNET', source: 'http', apr: Number.NaN }]);
        await service.fetchAndStoreYields({}, 'MAINNET');

        expect(repository.storeTokenYields).not.toHaveBeenCalled();
        expect(repository.deleteStaleTokenYields).not.toHaveBeenCalled();
    });
});

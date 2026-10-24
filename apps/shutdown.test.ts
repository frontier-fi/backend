import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdown, Stoppable } from './shutdown';

describe('createShutdown', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('stops the parts in order, then cleans up and exits with 0', async () => {
        const calls: string[] = [];
        const exit = vi.fn();
        const parts: Stoppable[] = [
            { stop: () => void calls.push('scheduler') },
            {
                stop: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    calls.push('worker');
                },
            },
        ];

        await createShutdown(parts, { cleanup: async () => void calls.push('cleanup'), exit })('SIGTERM');

        expect(calls).toEqual(['scheduler', 'worker', 'cleanup']);
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    });

    it('stops parts added after it was created', async () => {
        const parts: Stoppable[] = [];
        const shutdown = createShutdown(parts, { cleanup: async () => undefined, exit: vi.fn() });
        const stop = vi.fn();
        parts.push({ stop });

        await shutdown('SIGTERM');

        expect(stop).toHaveBeenCalledOnce();
    });

    it('carries on after a failing part and exits with 1', async () => {
        const calls: string[] = [];
        const exit = vi.fn();
        const parts: Stoppable[] = [
            {
                stop: () => {
                    throw new Error('close failed');
                },
            },
            { stop: () => void calls.push('next') },
        ];

        await createShutdown(parts, { cleanup: async () => void calls.push('cleanup'), exit })('SIGTERM');

        expect(calls).toEqual(['next', 'cleanup']);
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('exits with 1 when the deadline passes', async () => {
        vi.useFakeTimers();
        const exit = vi.fn();
        const hanging: Stoppable = { stop: () => new Promise<void>(() => undefined) };

        void createShutdown([hanging], { cleanup: async () => undefined, exit, deadlineMs: 1_000 })('SIGTERM');

        await vi.advanceTimersByTimeAsync(999);
        expect(exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('shuts down once when a second signal arrives', async () => {
        const stop = vi.fn();
        const exit = vi.fn();
        const shutdown = createShutdown([{ stop }], { cleanup: async () => undefined, exit });

        await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

        expect(stop).toHaveBeenCalledOnce();
        expect(exit).toHaveBeenCalledOnce();
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../apps/env';
import { findConsoleViolations } from '../../scripts/check-no-console';
import { logger, MAX_LOG_LINE_BYTES } from './logger';

describe('logger', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('writes info and debug JSON lines to stdout and warn and error JSON lines to stderr', () => {
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        logger.debug('Debug event', { count: 1n });
        logger.info('Info event', { chain: 'BASE' });
        logger.warn('Warn event', { failedPools: 2 });
        logger.error('Error event', { poolId: '0xpool' });

        expect(stdout).toHaveBeenCalledTimes(2);
        expect(stderr).toHaveBeenCalledTimes(2);

        const debugLine = JSON.parse(String(stdout.mock.calls[0][0]));
        const infoLine = JSON.parse(String(stdout.mock.calls[1][0]));
        const warnLine = JSON.parse(String(stderr.mock.calls[0][0]));
        const errorLine = JSON.parse(String(stderr.mock.calls[1][0]));

        expect(debugLine).toEqual({ level: 'debug', message: 'Debug event', count: '1' });
        expect(infoLine).toEqual({ level: 'info', message: 'Info event', chain: 'BASE' });
        expect(warnLine).toEqual({ level: 'warn', message: 'Warn event', failedPools: 2 });
        expect(errorLine).toEqual({ level: 'error', message: 'Error event', poolId: '0xpool' });
    });

    it('extracts error and stack frames via { err }, strips repeated error message, and redacts secrets', () => {
        const previousKey = env.DRPC_API_KEY;
        env.DRPC_API_KEY = 'secret-drpc-key';
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        try {
            const payload = 'x'.repeat(4_000);
            const err = new Error(`HTTP failed at https://lb.drpc.live/base/secret-drpc-key ${payload}`);
            err.stack = [
                `Error: HTTP failed at https://lb.drpc.live/base/secret-drpc-key ${payload}`,
                '    at fetchJson (https://lb.drpc.live/base/secret-drpc-key:10:5)',
                ...Array.from({ length: 20 }, (_, i) => `    at frame${i} (/app/index.js:${i}:1)`),
            ].join('\n');

            logger.error('Pool sync failed', {
                chain: 'BASE',
                endpoint: 'https://lb.drpc.live/base/secret-drpc-key',
                err,
            });

            const raw = String(stderr.mock.calls[0][0]);
            expect(raw.endsWith('\n')).toBe(true);
            expect(raw).not.toContain('secret-drpc-key');
            expect(Buffer.byteLength(raw.trimEnd(), 'utf8')).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);

            const parsed = JSON.parse(raw);
            expect(parsed).toMatchObject({
                level: 'error',
                message: 'Pool sync failed',
                chain: 'BASE',
                endpoint: 'https://lb.drpc.live/base/***',
            });
            expect(parsed.error).toContain('https://lb.drpc.live/base/***');
            expect(parsed.error.endsWith('…')).toBe(true);
            expect(parsed.stack).toMatch(/^\s*at fetchJson/);
            expect(parsed.stack).toContain('https://lb.drpc.live/base/***');
            expect(parsed.stack).not.toContain('xxxx');
        } finally {
            env.DRPC_API_KEY = previousKey;
        }
    });

    it('caps multi-byte, JSON-escaped, and oversized field payloads to <= 1,600 UTF-8 bytes', () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const payload = '─"\\\n\u001b😀'.repeat(300);
        const err = new Error(payload);
        err.stack = `Error: ${payload}\n${`    at ${payload} (/app/index.js:1:1)\n`.repeat(10)}`;

        logger.error('Multi-byte failure', { err });
        logger.error('Oversized fields failure', { big: 'a'.repeat(5_000), err: new Error('boom') });

        for (const call of stderr.mock.calls) {
            const line = String(call[0]).trimEnd();
            expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
            expect(Buffer.from(line, 'utf8').toString('utf8')).toBe(line);
            const parsed = JSON.parse(line);
            expect(parsed.level).toBe('error');
        }

        const second = JSON.parse(String(stderr.mock.calls[1][0]));
        expect(second).toMatchObject({
            level: 'error',
            message: 'Oversized fields failure',
            truncatedFields: true,
            error: 'boom',
        });
    });
});

describe('check-no-console', () => {
    it('finds zero console.* calls in apps, modules, config, and prisma', () => {
        expect(findConsoleViolations()).toEqual([]);
    });
});

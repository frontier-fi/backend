import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpTokenYieldHandler } from './http-yield-handler';

const config = {
    url: 'https://example.com/apr',
    scale: 100,
    extractors: [{ type: 'path', token: '0xtoken', path: '$.yearlyAPR' }],
} as const;

describe('httpTokenYieldHandler', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('extracts and scales the APR from the response body', async () => {
        vi.stubGlobal('fetch', async () => ({ json: async () => ({ yearlyAPR: '2.5' }) }));

        expect(await httpTokenYieldHandler(config)).toEqual([{ address: '0xtoken', apr: 0.025 }]);
    });

    it('times out when the response body stalls after the headers arrived', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', async () => ({ json: () => new Promise(() => {}) }));

        const rejection = expect(httpTokenYieldHandler(config)).rejects.toBe(
            'https://example.com/apr timed out after 20000ms',
        );
        await vi.advanceTimersByTimeAsync(20_000);

        await rejection;
    });
});

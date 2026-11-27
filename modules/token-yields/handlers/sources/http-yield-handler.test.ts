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

    it('skips null and undefined enumerate entries while preserving zero APR', async () => {
        vi.stubGlobal('fetch', async () => ({
            json: async () => ({
                data: {
                    vaultV2s: {
                        items: [
                            { address: '0xAAA', avgNetApy: 0.05, netApy: 0.04 },
                            { address: '0xBBB', avgNetApy: null, netApy: 0.065 },
                            { address: '0xCCC', avgNetApy: 0, netApy: 0.03 },
                            { address: '0xDDD', avgNetApy: null, netApy: null },
                            { address: '0xEEE', avgNetApy: undefined, netApy: undefined },
                            { address: '0xSKIP', skip: true },
                        ],
                    },
                },
            }),
        }));

        const result = await httpTokenYieldHandler({
            url: 'https://example.com/vaults',
            extractors: [
                {
                    type: 'enumerate',
                    path: '$.data.vaultV2s.items',
                    entries: (vault: any) =>
                        vault.skip ? null : [vault.address.toLowerCase(), vault.avgNetApy ?? vault.netApy ?? null],
                },
            ],
        });

        expect(result).toEqual([
            { address: '0xaaa', apr: 0.05 },
            { address: '0xbbb', apr: 0.065 },
            { address: '0xccc', apr: 0 },
        ]);
    });

    it('omits null enumerate entries before scaling so they do not become zero', async () => {
        vi.stubGlobal('fetch', async () => ({
            json: async () => ({
                items: [
                    { address: '0x1', rate: 5 },
                    { address: '0x2', rate: null },
                ],
            }),
        }));

        const result = await httpTokenYieldHandler({
            url: 'https://example.com/rates',
            scale: 100,
            extractors: [
                {
                    type: 'enumerate',
                    path: '$.items',
                    entries: (item: any) => [item.address, item.rate],
                },
            ],
        });

        expect(result).toEqual([{ address: '0x1', apr: 0.05 }]);
    });
});

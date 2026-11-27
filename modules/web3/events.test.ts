import { afterEach, beforeEach, describe, expect, it, MockedFunction, vi } from 'vitest';
import { getEvents } from './events';

// Mock `fetch` globally
global.fetch = vi.fn() as unknown as typeof fetch;

const mockedFetch = () => global.fetch as MockedFunction<typeof fetch>;

const extractRangesFromFetchCalls = () =>
    mockedFetch().mock.calls.map(([, init]) => {
        const body = JSON.parse(String(init?.body));
        const params = body.params[0];
        return [parseInt(params.fromBlock, 16), parseInt(params.toBlock, 16)] as [number, number];
    });

describe('getEvents', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockedFetch().mockReset();
        stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('fetches successfully using exact inclusive block chunks', async () => {
        mockedFetch().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ result: [] }))));

        const result = await getEvents(0, 100, ['0x123'], ['0x456'], 'http://localhost', 50);
        expect(result).toEqual([]);
        expect(global.fetch).toHaveBeenCalledTimes(3);
        expect(extractRangesFromFetchCalls()).toEqual([
            [0, 49],
            [50, 99],
            [100, 100],
        ]);
    });

    it('queries single-block ranges when fromBlock === toBlock', async () => {
        mockedFetch().mockImplementation(() =>
            Promise.resolve(new Response(JSON.stringify({ result: [{ address: '0x123' }] }))),
        );

        const result = await getEvents(42, 42, ['0x123'], ['0x456'], 'http://localhost', 50);
        expect(result).toEqual([{ address: '0x123' }]);
        expect(extractRangesFromFetchCalls()).toEqual([[42, 42]]);
    });

    it('handles fetch error', async () => {
        mockedFetch().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ result: [] }))));
        mockedFetch().mockImplementationOnce(() => Promise.reject('Fetch error'));

        await expect(getEvents(0, 100, ['0x123'], ['0x456'], 'http://localhost', 50)).rejects.toEqual('Fetch error');
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('splits address lists larger than maxAddresses into separate requests', async () => {
        const addresses = new Array(501).fill('0x1');
        const log = { address: 'address' };

        mockedFetch().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ result: [log] }))));

        const result = await getEvents(0, 1, addresses, ['0xtopic'], 'http://localhost', 10, undefined, 500);

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(2);
    });

    it('bisects block ranges with integer midpoints on -32602 / range-limit errors', async () => {
        const coveredBlocks = new Set<number>();

        mockedFetch().mockImplementation(async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            const from = parseInt(body.params[0].fromBlock, 16);
            const to = parseInt(body.params[0].toBlock, 16);
            const span = to - from + 1;

            if (span > 25) {
                return new Response(
                    JSON.stringify({
                        error: { code: -32602, message: 'block range exceeds max block range 25' },
                    }),
                );
            }

            for (let b = from; b <= to; b++) {
                expect(coveredBlocks.has(b)).toBe(false);
                coveredBlocks.add(b);
            }
            return new Response(JSON.stringify({ result: [{ address: `0x${from}` }] }));
        });

        const logs = await getEvents(100, 150, ['0x123'], ['0x456'], 'http://localhost', 51, undefined, 4000, {
            retryDelayMs: 0,
        });

        // 51 blocks (100..150): [100,150] -> [100,125] (26 -> splits into [100,112],[113,125]) + [126,150] (25 -> ok)
        expect(coveredBlocks.size).toBe(51);
        expect(logs).toHaveLength(3);
        expect(extractRangesFromFetchCalls()).toEqual([
            [100, 150],
            [100, 125],
            [100, 112],
            [113, 125],
            [126, 150],
        ]);
    });

    it('retries transient head-skew and small-range -32602 errors up to maxRetries and stops when exhausted', async () => {
        const sleep = vi.fn(async () => {});

        mockedFetch()
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: -32602, message: 'unknown block' } })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ result: [{ address: '0xabc' }] })));

        const logs = await getEvents(100, 105, ['0x123'], ['0x456'], 'http://localhost', 50, undefined, 4000, {
            maxRetries: 2,
            retryDelayMs: 100,
            sleep,
        });

        expect(logs).toEqual([{ address: '0xabc' }]);
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);

        // Exhausting retries on persistent -32602 terminates instead of recursing infinitely
        mockedFetch().mockReset();
        sleep.mockReset();
        mockedFetch().mockImplementation(() =>
            Promise.resolve(new Response(JSON.stringify({ error: { code: -32602, message: 'invalid params' } }))),
        );

        await expect(
            getEvents(100, 102, ['0x123'], ['0x456'], 'http://localhost', 50, undefined, 4000, {
                maxRetries: 2,
                retryDelayMs: 50,
                sleep,
            }),
        ).rejects.toThrow(/fromBlock=100, toBlock=102, blocks=3.*invalid params.*code=-32602/);
        expect(global.fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('fails fast on non-retryable HTTP 401/403 responses', async () => {
        const sleep = vi.fn(async () => {});
        mockedFetch().mockResolvedValue(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }));

        await expect(
            getEvents(100, 200, ['0x123'], ['0x456'], 'http://localhost', 200, undefined, 4000, {
                maxRetries: 3,
                retryDelayMs: 100,
                sleep,
            }),
        ).rejects.toThrow(/HTTP 403 Forbidden.*status=403/);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('rejects malformed non-array RPC results such as result: null instead of returning an empty batch', async () => {
        mockedFetch().mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })));

        await expect(getEvents(100, 110, ['0x123'], ['0x456'], 'http://localhost', 50)).rejects.toThrow(
            /Invalid non-array result/,
        );

        mockedFetch().mockResolvedValueOnce(
            new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { unexpected: true } })),
        );

        await expect(getEvents(100, 110, ['0x123'], ['0x456'], 'http://localhost', 50)).rejects.toThrow(
            /Invalid non-array result/,
        );
    });

    it('backs off and retries [1, 500] on HTTP 429 with -32005 and rate limit exceeded instead of splitting', async () => {
        let slept = false;
        const sleep = vi.fn(async () => {
            slept = true;
        });

        mockedFetch().mockImplementation(async () => {
            if (!slept) {
                return new Response(JSON.stringify({ error: { code: -32005, message: 'rate limit exceeded' } }), {
                    status: 429,
                });
            }
            return new Response(JSON.stringify({ result: [{ address: '0xratelimitok' }] }));
        });

        const logs = await getEvents(1, 500, ['0x123'], ['0x456'], 'http://localhost', 500, undefined, 4000, {
            maxRetries: 2,
            retryDelayMs: 100,
            sleep,
        });

        expect(sleep).toHaveBeenCalledTimes(1);
        expect(logs).toEqual([{ address: '0xratelimitok' }]);
        expect(extractRangesFromFetchCalls()).toEqual([
            [1, 500],
            [1, 500],
        ]);
    });

    it('backs off and retries [1, 500] on -32602 with block range extends beyond current head instead of splitting', async () => {
        let slept = false;
        const sleep = vi.fn(async () => {
            slept = true;
        });

        mockedFetch().mockImplementation(async () => {
            if (!slept) {
                return new Response(
                    JSON.stringify({ error: { code: -32602, message: 'block range extends beyond current head' } }),
                );
            }
            return new Response(JSON.stringify({ result: [{ address: '0xheadok' }] }));
        });

        const logs = await getEvents(1, 500, ['0x123'], ['0x456'], 'http://localhost', 500, undefined, 4000, {
            maxRetries: 2,
            retryDelayMs: 100,
            sleep,
        });

        expect(sleep).toHaveBeenCalledTimes(1);
        expect(logs).toEqual([{ address: '0xheadok' }]);
        expect(extractRangesFromFetchCalls()).toEqual([
            [1, 500],
            [1, 500],
        ]);
    });

    it('bisects [1, 500] into [1, 250] and [251, 500] without sleeping when -32602 says exceeds current maximum block range of 250', async () => {
        const sleep = vi.fn(async () => {});

        mockedFetch().mockImplementation(async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            const from = parseInt(body.params[0].fromBlock, 16);
            const to = parseInt(body.params[0].toBlock, 16);

            if (to - from + 1 > 250) {
                return new Response(
                    JSON.stringify({
                        error: {
                            code: -32602,
                            message: 'exceeds current maximum block range of 250',
                        },
                    }),
                );
            }
            return new Response(JSON.stringify({ result: [{ address: `0x${from}` }] }));
        });

        const logs = await getEvents(1, 500, ['0x123'], ['0x456'], 'http://localhost', 500, undefined, 4000, {
            sleep,
        });

        expect(sleep).not.toHaveBeenCalled();
        expect(logs).toEqual([{ address: '0x1' }, { address: '0x251' }]);
        expect(extractRangesFromFetchCalls()).toEqual([
            [1, 500],
            [1, 250],
            [251, 500],
        ]);
    });

    it('rejects promptly and aborts remaining in-flight requests when one chunk hits a fatal error', async () => {
        let stalledSignal: AbortSignal | undefined;

        mockedFetch().mockImplementation((_url, init) => {
            const body = JSON.parse(String(init?.body));
            const from = parseInt(body.params[0].fromBlock, 16);

            if (from === 0) {
                stalledSignal = init?.signal ?? undefined;
                // Intentionally never resolves unless aborted (and even if ignored, Promise.all rejects immediately)
                return new Promise<Response>(() => {});
            }

            return Promise.resolve(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }));
        });

        await expect(
            getEvents(0, 999, ['0x123'], ['0x456'], 'http://localhost', 500, undefined, 4000, {
                maxConcurrency: 2,
            }),
        ).rejects.toThrow(/HTTP 403 Forbidden.*status=403/);

        expect(stalledSignal).toBeDefined();
        expect(stalledSignal?.aborted).toBe(true);
    });

    it('bounds chunk concurrency and applies exponential backoff with jitter on rate-limit retries', async () => {
        let inFlight = 0;
        let maxInFlight = 0;

        mockedFetch().mockImplementation(async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            const from = parseInt(body.params[0].fromBlock, 16);
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight--;
            return new Response(JSON.stringify({ result: [{ address: `0x${from}` }] }));
        });

        // 20 chunks of 500 blocks each (10,000 blocks total); default concurrency cap is 5
        const logs = await getEvents(0, 9999, ['0x123'], ['0x456'], 'http://localhost', 500);

        expect(maxInFlight).toBeLessThanOrEqual(5);
        expect(maxInFlight).toBeGreaterThan(1);
        expect(logs).toHaveLength(20);
        // Preserves chronological chunk ordering
        expect(logs[0]).toEqual({ address: '0x0' });
        expect(logs[19]).toEqual({ address: '0x9500' });

        // Verify exponential backoff + jitter on 429 rate-limit retries
        mockedFetch().mockReset();
        const delays: number[] = [];
        const sleep = vi.fn(async (ms: number) => {
            delays.push(ms);
        });
        const randomValues = [0.2, 0.8];
        let randomIdx = 0;

        mockedFetch()
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ error: { code: 429, message: 'rate limit exceeded' } }), { status: 429 }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ error: { code: 429, message: 'rate limit exceeded' } }), { status: 429 }),
            )
            .mockResolvedValueOnce(new Response(JSON.stringify({ result: [{ address: '0xok' }] })));

        const retried = await getEvents(0, 10, ['0x123'], ['0x456'], 'http://localhost', 50, undefined, 4000, {
            maxRetries: 3,
            retryDelayMs: 1000,
            sleep,
            random: () => randomValues[randomIdx++] ?? 0,
        });

        expect(retried).toEqual([{ address: '0xok' }]);
        // attempt 0: 1000 + floor(250 * 0.2) = 1050; attempt 1: 2000 + floor(500 * 0.8) = 2400
        expect(delays).toEqual([1050, 2400]);
    });
});

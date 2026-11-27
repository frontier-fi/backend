import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, HttpRequestError, InvalidParamsRpcError, RpcRequestError } from 'viem';
import { formatLogLine } from '../../common/logger';
import { ViemClient } from '../types';
import { createRpcHttpTransport } from '../viem-client';
import { getChangedPoolsV3 } from './get-changed-pools';

const VAULT_ADDRESS = '0xFF00009C1A83Ec25434522ef355b99e9a70000FF';

const makeViemInvalidParamsError = (details: string, fromBlock: bigint, toBlock: bigint) => {
    const fakeTopics = Array.from({ length: 7 }, (_, i) => `0x${String(i + 1).repeat(64)}`);
    const rpcErr = new RpcRequestError({
        url: 'https://lb.drpc.live/monad/test',
        body: {
            method: 'eth_getLogs',
            params: [
                {
                    address: VAULT_ADDRESS,
                    topics: [fakeTopics],
                    fromBlock: `0x${fromBlock.toString(16)}`,
                    toBlock: `0x${toBlock.toString(16)}`,
                },
            ],
        },
        error: {
            code: -32602,
            message: details,
        },
    });
    return new InvalidParamsRpcError(rpcErr);
};

describe('getChangedPoolsV3', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('fetches logs in a single call, deduplicates, and lowercases pool addresses', async () => {
        const getLogs = vi
            .fn()
            .mockResolvedValue([
                { args: { pool: '0xAbCd000000000000000000000000000000000001' } },
                { args: { pool: '0xabcd000000000000000000000000000000000001' } },
                { args: { pool: '0x1234000000000000000000000000000000000002' } },
            ]);
        const client = { getLogs } as unknown as ViemClient;

        const pools = await getChangedPoolsV3(VAULT_ADDRESS, client, 100n, 200n);

        expect(getLogs).toHaveBeenCalledTimes(1);
        expect(getLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                address: VAULT_ADDRESS,
                fromBlock: 100n,
                toBlock: 200n,
            }),
        );
        expect(pools).toEqual([
            '0xabcd000000000000000000000000000000000001',
            '0x1234000000000000000000000000000000000002',
        ]);
        expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('returns empty array without calling RPC when fromBlock > toBlock', async () => {
        const getLogs = vi.fn();
        const client = { getLogs } as unknown as ViemClient;

        await expect(getChangedPoolsV3(VAULT_ADDRESS, client, 201n, 200n)).resolves.toEqual([]);
        expect(getLogs).not.toHaveBeenCalled();
    });

    it('recursively halves block ranges on -32602 / range-limit errors without dropping or duplicating boundary blocks', async () => {
        const queriedRanges: Array<[bigint, bigint]> = [];
        const coveredBlocks = new Set<bigint>();

        const getLogs = vi
            .fn()
            .mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
                queriedRanges.push([fromBlock, toBlock]);
                const span = toBlock - fromBlock + 1n;
                if (span > 100n) {
                    throw makeViemInvalidParamsError(
                        'eth_getLogs range exceeds max block range of 100',
                        fromBlock,
                        toBlock,
                    );
                }

                // Record every block covered by successful leaf requests and assert no duplicates.
                for (let b = fromBlock; b <= toBlock; b++) {
                    expect(coveredBlocks.has(b)).toBe(false);
                    coveredBlocks.add(b);
                }

                if (fromBlock <= 1000n && toBlock >= 1000n) {
                    return [{ args: { pool: '0xAAA0000000000000000000000000000000000001' } }];
                }
                if (fromBlock <= 1250n && toBlock >= 1250n) {
                    return [
                        { args: { pool: '0xaaa0000000000000000000000000000000000001' } },
                        { args: { pool: '0xBBB0000000000000000000000000000000000002' } },
                    ];
                }
                return [];
            });

        const client = { getLogs } as unknown as ViemClient;
        const pools = await getChangedPoolsV3(VAULT_ADDRESS, client, 1000n, 1300n);

        // Exact inclusive coverage of all 301 blocks (1000..1300)
        expect(coveredBlocks.size).toBe(301);
        expect(Math.min(...Array.from(coveredBlocks).map(Number))).toBe(1000);
        expect(Math.max(...Array.from(coveredBlocks).map(Number))).toBe(1300);

        // Verify exact bisection boundaries: [1000,1300] -> [1000,1150] + [1151,1300] -> 4 leaves
        expect(queriedRanges).toEqual([
            [1000n, 1300n],
            [1000n, 1150n],
            [1000n, 1075n],
            [1076n, 1150n],
            [1151n, 1300n],
            [1151n, 1225n],
            [1226n, 1300n],
        ]);
        expect(pools).toEqual([
            '0xaaa0000000000000000000000000000000000001',
            '0xbbb0000000000000000000000000000000000002',
        ]);
    });

    it('retries transient head-skew errors with bounded backoff and succeeds on retry', async () => {
        const sleepDelays: number[] = [];
        const sleep = vi.fn(async (ms: number) => {
            sleepDelays.push(ms);
        });

        const getLogs = vi
            .fn()
            .mockRejectedValueOnce(makeViemInvalidParamsError('toBlock is beyond current head', 1000n, 1080n))
            .mockRejectedValueOnce(makeViemInvalidParamsError('unknown block', 1000n, 1080n))
            .mockResolvedValueOnce([{ args: { pool: '0xCCC0000000000000000000000000000000000003' } }]);

        const client = { getLogs } as unknown as ViemClient;
        const pools = await getChangedPoolsV3(VAULT_ADDRESS, client, 1000n, 1080n, {
            maxRetries: 3,
            retryDelayMs: 500,
            sleep,
        });

        expect(pools).toEqual(['0xccc0000000000000000000000000000000000003']);
        expect(getLogs).toHaveBeenCalledTimes(3);
        expect(sleepDelays).toEqual([500, 1000]);
    });

    it('retries small-range ambiguous -32602 errors with bounded backoff and succeeds on retry', async () => {
        const sleepDelays: number[] = [];
        const sleep = vi.fn(async (ms: number) => {
            sleepDelays.push(ms);
        });

        const getLogs = vi
            .fn()
            .mockRejectedValueOnce(makeViemInvalidParamsError('invalid params', 1000n, 1000n))
            .mockResolvedValueOnce([{ args: { pool: '0xDDD0000000000000000000000000000000000004' } }]);

        const client = { getLogs } as unknown as ViemClient;
        const pools = await getChangedPoolsV3(VAULT_ADDRESS, client, 1000n, 1000n, {
            maxRetries: 2,
            retryDelayMs: 500,
            sleep,
        });

        expect(pools).toEqual(['0xddd0000000000000000000000000000000000004']);
        expect(getLogs).toHaveBeenCalledTimes(2);
        expect(sleepDelays).toEqual([500]);
    });

    it('throws a concise front-loaded diagnostic error preserving fromBlock, toBlock, code, and details inside MAX_LOG_ERROR_CHARS', async () => {
        const sleep = vi.fn(async () => {});
        const upstreamDetails = 'block range exceeds max allowed limit of 100 blocks on this node';
        const originalErr = makeViemInvalidParamsError(upstreamDetails, 125869000n, 125869005n);

        // Sanity check that viem's raw error message is indeed longer than 500 chars due to the 7 topics
        expect(originalErr.message.length).toBeGreaterThan(500);

        const getLogs = vi.fn().mockRejectedValue(originalErr);
        const client = { getLogs } as unknown as ViemClient;

        let caught: Error | undefined;
        try {
            await getChangedPoolsV3(VAULT_ADDRESS, client, 125869000n, 125869005n, {
                maxRetries: 2,
                retryDelayMs: 100,
                maxSplitDepth: 0,
                sleep,
            });
        } catch (err) {
            caught = err as Error;
        }

        expect(caught).toBeInstanceOf(Error);
        expect(caught?.cause).toBe(originalErr);
        expect(caught?.message).toContain('fromBlock=125869000');
        expect(caught?.message).toContain('toBlock=125869005');
        expect(caught?.message).toContain('blocks=6');
        expect(caught?.message).toContain('code=-32602');
        expect(caught?.message).toContain(upstreamDetails);

        const logLine = formatLogLine('error', 'Error executing job', {
            job: 'sync-pools-v3',
            chain: 'MONAD',
            err: caught,
        });
        const parsed = JSON.parse(logLine);
        expect(parsed.error.length).toBeLessThanOrEqual(500);
        expect(parsed.error).toContain('fromBlock=125869000');
        expect(parsed.error).toContain('toBlock=125869005');
        expect(parsed.error).toContain('code=-32602');
        expect(parsed.error).toContain(upstreamDetails);
    });

    it('fails fast on non-retryable HTTP 401/403 and malformed-parameter errors without splitting or retrying', async () => {
        const sleep = vi.fn(async () => {});
        const authErr = new HttpRequestError({
            url: 'https://lb.drpc.live/monad/test',
            status: 403,
            details: 'Forbidden: invalid API key',
        });
        const getLogsAuth = vi.fn().mockRejectedValue(authErr);

        await expect(
            getChangedPoolsV3(VAULT_ADDRESS, { getLogs: getLogsAuth } as unknown as ViemClient, 1000n, 2000n, {
                sleep,
            }),
        ).rejects.toThrow(/status=403.*Forbidden: invalid API key/);
        expect(getLogsAuth).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();

        const malformedErr = makeViemInvalidParamsError('invalid address format', 1000n, 2000n);
        const getLogsMalformed = vi.fn().mockRejectedValue(malformedErr);

        await expect(
            getChangedPoolsV3(VAULT_ADDRESS, { getLogs: getLogsMalformed } as unknown as ViemClient, 1000n, 2000n, {
                sleep,
            }),
        ).rejects.toThrow(/code=-32602.*invalid address format/);
        expect(getLogsMalformed).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('bisects rather than retrying when error says fromBlock to toBlock exceeds current maximum block range', async () => {
        const sleep = vi.fn(async () => {});
        const queriedRanges: Array<[bigint, bigint]> = [];

        const getLogs = vi
            .fn()
            .mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
                queriedRanges.push([fromBlock, toBlock]);
                if (toBlock - fromBlock + 1n > 250n) {
                    throw makeViemInvalidParamsError(
                        'fromBlock to toBlock exceeds current maximum block range of 250',
                        fromBlock,
                        toBlock,
                    );
                }
                return [];
            });

        await expect(
            getChangedPoolsV3(VAULT_ADDRESS, { getLogs } as unknown as ViemClient, 1000n, 1499n, { sleep }),
        ).resolves.toEqual([]);

        expect(sleep).not.toHaveBeenCalled();
        expect(queriedRanges).toEqual([
            [1000n, 1499n],
            [1000n, 1249n],
            [1250n, 1499n],
        ]);
    });

    it('preserves HTTP 403 status and avoids transport retries even when body carries -32602, -32603, -32005, or plain text', async () => {
        const sleep = vi.fn(async () => {});
        const url = 'https://lb.drpc.live/monad/test';

        for (const [label, body, expectedPattern] of [
            [
                '-32602',
                JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }),
                /code=-32602, status=403.*Invalid params/,
            ],
            [
                '-32603',
                JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } }),
                /code=-32603, status=403.*Internal error/,
            ],
            [
                '-32005',
                JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Limit exceeded' } }),
                /code=-32005, status=403.*Limit exceeded/,
            ],
            ['plain text', 'Forbidden', /status=403.*Forbidden/],
        ] as const) {
            const fetchFn = vi.fn(async () => {
                return new Response(body, {
                    status: 403,
                    statusText: 'Forbidden',
                    headers: {
                        'Content-Type': label === 'plain text' ? 'text/plain' : 'application/json',
                    },
                });
            });

            const client = createPublicClient({
                transport: createRpcHttpTransport(url, { fetchFn, retryDelay: 1 }),
            }) as unknown as ViemClient;

            await expect(getChangedPoolsV3(VAULT_ADDRESS, client, 1000n, 1499n, { sleep })).rejects.toThrow(
                expectedPattern,
            );
            expect(fetchFn, `HTTP 403 (${label}) must fail in 1 transport attempt`).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        }
    });

    it('still retries transient HTTP 503 responses at the transport boundary', async () => {
        const url = 'https://lb.drpc.live/monad/test';
        const fetchFn = vi
            .fn()
            .mockResolvedValueOnce(
                new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        const client = createPublicClient({
            transport: createRpcHttpTransport(url, { fetchFn, retryDelay: 1 }),
        }) as unknown as ViemClient;

        await expect(getChangedPoolsV3(VAULT_ADDRESS, client, 1000n, 1010n)).resolves.toEqual([]);
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });
});

import { Interface, LogDescription } from 'ethers';
import { chunk } from 'lodash';
import { logger } from '../common/logger';

export type DecodedEventLog = {
    address: string;
    topics?: readonly string[];
    data?: string;
    args?: Record<string, unknown>;
};

export interface GetEventsOptions {
    maxRetries?: number;
    retryDelayMs?: number;
    maxSplitDepth?: number;
    minSplitRange?: number;
    sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_SPLIT_DEPTH = 14;
const DEFAULT_MIN_SPLIT_RANGE = 10;

const NON_RETRYABLE_STATUS_CODES = new Set([401, 403, 404]);

const NON_RETRYABLE_PATTERN =
    /\b(unauthorized|forbidden|invalid api key|api key|malformed|invalid address|invalid topic|invalid hex|method not found|unsupported method)\b/i;

const HEAD_SKEW_PATTERN =
    /(unknown block|after last accepted block|block not found|header not found|beyond (the )?(current )?(head|latest)|exceeds (the )?(current )?(head|latest)|ahead of (the )?(current )?(head|latest)|future block|(toblock|fromblock)[^\n]{0,40}(greater than|exceeds|after|beyond|latest|head|current)|requested block[^\n]{0,40}(not found|unavailable|future))/i;

const RANGE_LIMIT_PATTERN =
    /(block range|max(imum)?\s+range|block window|range (is )?too (wide|large)|too many blocks|limited to\b|exceeds? max|exceeded max|more than \d+ (results|logs|blocks)|too many results|log response size|response size exceeded)/i;

const RATE_LIMIT_PATTERN =
    /(Your app has exceeded its compute units per second capacity|rate limit exceeded|Total number of requests exceeded|too many requests)/i;

class RpcLogsError extends Error {
    readonly code?: number;
    readonly status?: number;
    readonly rpcMessage: string;

    constructor(rpcMessage: string, options?: { code?: number; status?: number }) {
        const meta: string[] = [];
        if (options?.code !== undefined) {
            meta.push(`code=${options.code}`);
        }
        if (options?.status !== undefined) {
            meta.push(`status=${options.status}`);
        }
        super(meta.length > 0 ? `${rpcMessage} (${meta.join(', ')})` : rpcMessage);
        this.name = 'RpcLogsError';
        this.rpcMessage = rpcMessage;
        this.code = options?.code;
        this.status = options?.status;
    }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const parseRpcCode = (code: unknown): number | undefined => {
    if (typeof code === 'number' && Number.isFinite(code)) {
        return code;
    }
    if (typeof code === 'string' && /^-?\d+$/.test(code.trim())) {
        return Number(code.trim());
    }
    return undefined;
};

const extractErrorDetails = (err: unknown): { code?: number; status?: number; message: string } => {
    if (err instanceof RpcLogsError) {
        return { code: err.code, status: err.status, message: err.rpcMessage };
    }
    if (err instanceof Error) {
        return { message: err.message };
    }
    if (typeof err === 'string') {
        return { message: err };
    }
    return { message: String(err) };
};

export const getEvents = async (
    fromBlock: number,
    toBlock: number,
    addresses: string[],
    topics: string[],
    rpcUrl: string,
    rpcMaxBlockRange: number,
    abi?: any,
    maxAddresses = 4000,
    options?: GetEventsOptions,
): Promise<DecodedEventLog[]> => {
    let iEvents: Interface | undefined;
    if (abi && abi.length > 0) {
        iEvents = new Interface(abi);
        // check if topics are event names, if so, encode them
        topics = topics.map((topic) => {
            if (topic.startsWith('0x')) {
                return topic;
            }
            const fragment = iEvents?.getEvent(topic);
            if (!fragment) {
                throw new Error(`Unknown event ${topic}`);
            }
            return fragment.topicHash;
        });
    }

    if (fromBlock > toBlock || addresses.length === 0) {
        return [];
    }

    const effectiveMaxBlockRange = Math.max(1, Math.floor(rpcMaxBlockRange));
    const effectiveMaxAddresses = Math.max(1, Math.floor(maxAddresses));
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const maxSplitDepth = options?.maxSplitDepth ?? DEFAULT_MAX_SPLIT_DEPTH;
    const minSplitRange = options?.minSplitRange ?? DEFAULT_MIN_SPLIT_RANGE;
    const sleep = options?.sleep ?? defaultSleep;

    const fetchChunk = async (
        from: number,
        to: number,
        addressChunk: string[],
        splitDepth: number,
    ): Promise<DecodedEventLog[]> => {
        const blockSpan = to - from + 1;

        for (let attempt = 0; ; attempt++) {
            try {
                return await fetchLogs(from, to, addressChunk, topics, rpcUrl);
            } catch (e: unknown) {
                const { code, status, message } = extractErrorDetails(e);

                const wrapLeafError = (err: unknown): unknown => {
                    if (err instanceof RpcLogsError) {
                        return new RpcLogsError(
                            `eth_getLogs failed (fromBlock=${from}, toBlock=${to}, blocks=${blockSpan}): ${err.rpcMessage}`,
                            { code: err.code, status: err.status },
                        );
                    }
                    return err;
                };

                if (
                    (status !== undefined && NON_RETRYABLE_STATUS_CODES.has(status)) ||
                    NON_RETRYABLE_PATTERN.test(message)
                ) {
                    throw wrapLeafError(e);
                }

                // Infura returns 'more than 10000 results' error if block range is too wide
                // error format:
                // "query returned more than 10000 results. Try with this block range [0x30CE171, 0x30CE1C9]."
                if (
                    message.includes('query returned more than 10000 results') &&
                    to > from &&
                    splitDepth < maxSplitDepth
                ) {
                    const rangeMatch = message.match(/\[([0-9a-fA-F, x]+)\]/);
                    let suggestedRange = Math.max(1, Math.floor(blockSpan / 2));
                    if (rangeMatch?.[1]) {
                        const parsed = rangeMatch[1].split(',').map((hex) => parseInt(hex.trim(), 16));
                        if (parsed.length === 2 && Number.isFinite(parsed[0]) && Number.isFinite(parsed[1])) {
                            const width = parsed[1] - parsed[0] + 1;
                            if (width >= 1 && width < blockSpan) {
                                suggestedRange = width;
                            }
                        }
                    }

                    const results: DecodedEventLog[] = [];
                    for (let start = from; start <= to;) {
                        const end = Math.min(start + suggestedRange - 1, to);
                        const chunkLogs = await fetchChunk(start, end, addressChunk, splitDepth + 1);
                        results.push(...chunkLogs);
                        start = end + 1;
                    }
                    return results;
                }

                // Allnodes addresses size limit
                if (
                    message.includes('specify less number of addresses') &&
                    addressChunk.length > 1 &&
                    splitDepth < maxSplitDepth
                ) {
                    if (retryDelayMs > 0) {
                        await sleep(retryDelayMs);
                    }
                    const halfAddresses = Math.max(1, Math.floor(addressChunk.length / 2));
                    const subChunks = chunk(addressChunk, halfAddresses);
                    const results: DecodedEventLog[] = [];
                    for (const subChunk of subChunks) {
                        results.push(...(await fetchChunk(from, to, subChunk, splitDepth + 1)));
                    }
                    return results;
                }

                // Handle missing block / head skew in the RPC logs by retrying with bounded retries
                if (HEAD_SKEW_PATTERN.test(message)) {
                    if (attempt < maxRetries) {
                        // rpcUrl carries the RPC API key, so it stays out of the log.
                        logger.warn('Retrying getEvents after transient missing block', {
                            fromBlock: from,
                            toBlock: to,
                            attempt: attempt + 1,
                            maxRetries,
                            rpcCode: code,
                        });
                        if (retryDelayMs > 0) {
                            await sleep(retryDelayMs);
                        }
                        continue;
                    }
                    throw wrapLeafError(e);
                }

                // Alchemy / tenderly / gateway.fm rate limit
                if (status === 429 || RATE_LIMIT_PATTERN.test(message)) {
                    if (attempt < maxRetries) {
                        if (retryDelayMs > 0) {
                            await sleep(retryDelayMs);
                        }
                        continue;
                    }
                    throw wrapLeafError(e);
                }

                // Block range limit or ambiguous -32602
                const isRangeLimit = code === -32005 || RANGE_LIMIT_PATTERN.test(message);
                const isAmbiguousInvalidParams = code === -32602;

                if (
                    to > from &&
                    splitDepth < maxSplitDepth &&
                    (isRangeLimit || (isAmbiguousInvalidParams && blockSpan > minSplitRange))
                ) {
                    const logFn = splitDepth === 0 ? logger.warn : logger.debug;
                    logFn('Bisecting getEvents block range after RPC error', {
                        fromBlock: from,
                        toBlock: to,
                        blocks: blockSpan,
                        splitDepth,
                        rpcCode: code,
                    });
                    const mid = Math.floor((from + to) / 2);
                    const left = await fetchChunk(from, mid, addressChunk, splitDepth + 1);
                    const right = await fetchChunk(mid + 1, to, addressChunk, splitDepth + 1);
                    return [...left, ...right];
                }

                if (isAmbiguousInvalidParams && attempt < maxRetries) {
                    logger.warn('Retrying getEvents after transient -32602 RPC error', {
                        fromBlock: from,
                        toBlock: to,
                        blocks: blockSpan,
                        attempt: attempt + 1,
                        maxRetries,
                        rpcCode: code,
                    });
                    if (retryDelayMs > 0) {
                        await sleep(retryDelayMs);
                    }
                    continue;
                }

                throw wrapLeafError(e);
            }
        }
    };

    const promises: Promise<DecodedEventLog[]>[] = [];

    for (let from = fromBlock; from <= toBlock;) {
        const to = Math.min(from + effectiveMaxBlockRange - 1, toBlock);
        const addressChunks = chunk(addresses, effectiveMaxAddresses);

        for (const addressChunk of addressChunks) {
            promises.push(fetchChunk(from, to, addressChunk, 0));
        }

        from = to + 1;
    }

    return Promise.all(promises)
        .then((res) => res.flat().filter((log) => log))
        .then((logs) => (iEvents ? decodeLogs(logs, iEvents) : logs));
};

const fetchLogs = async (
    from: number,
    to: number,
    addresses: string[],
    topics: string[],
    rpcUrl: string,
): Promise<DecodedEventLog[]> => {
    // Fetch logs with a raw json request until we support Viem or Ethers6
    const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [
            {
                address: addresses,
                topics: topics.length === 1 ? topics : [topics],
                fromBlock: '0x' + BigInt(from).toString(16),
                toBlock: '0x' + BigInt(to).toString(16),
            },
        ],
    };

    const httpResponse = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    let response:
        | { result: DecodedEventLog[] | { code?: number | string; message?: string } }
        | { error: { code?: number | string; message?: string } }
        | undefined;

    try {
        response = (await httpResponse.json()) as typeof response;
    } catch {
        if (!httpResponse.ok) {
            throw new RpcLogsError(`HTTP ${httpResponse.status} ${httpResponse.statusText}`.trim(), {
                status: httpResponse.status,
            });
        }
        throw new RpcLogsError('Invalid JSON response from eth_getLogs');
    }

    if (response && 'error' in response && response.error) {
        throw new RpcLogsError(response.error.message || 'RPC error', {
            code: parseRpcCode(response.error.code),
            status: httpResponse.ok ? undefined : httpResponse.status,
        });
    }

    if (!httpResponse.ok) {
        throw new RpcLogsError(`HTTP ${httpResponse.status} ${httpResponse.statusText}`.trim(), {
            status: httpResponse.status,
        });
    }

    if (!response || !('result' in response)) {
        throw new RpcLogsError('Missing result in eth_getLogs response');
    }

    // gateway.fm returns errors in results
    if (
        response.result &&
        typeof response.result === 'object' &&
        !Array.isArray(response.result) &&
        'code' in response.result
    ) {
        throw new RpcLogsError(response.result.message || 'RPC error', {
            code: parseRpcCode(response.result.code),
        });
    }

    return Array.isArray(response.result) ? response.result : [];
};

const decodeLogs = (logs: DecodedEventLog[], iEvents: Interface): DecodedEventLog[] => {
    return logs.map((log) => {
        const parsed: LogDescription | null =
            log.topics && log.data ? iEvents.parseLog({ topics: log.topics, data: log.data }) : null;
        const args: Record<string, unknown> = {};
        if (parsed) {
            parsed.fragment.inputs.forEach((input, index) => {
                args[input.name] = parsed.args[index];
            });
        }

        return {
            ...log,
            args,
        };
    });
};

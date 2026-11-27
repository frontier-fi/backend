import { ViemClient } from '../types';
import VaultV3 from '../contracts/abis/VaultV3';
import { logger } from '../../common/logger';

const events = VaultV3.filter(
    (i) =>
        i.type === 'event' &&
        [
            'PoolBalanceChanged',
            'Swap',
            'SwapFeePercentageChanged',
            'PoolPausedStateChanged',
            'PoolRecoveryModeStateChanged',
            'AggregateSwapFeePercentageChanged',
            'AggregateYieldFeePercentageChanged',
        ].includes(i.name),
);

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_SPLIT_DEPTH = 14;
const DEFAULT_MIN_SPLIT_RANGE = 10n;
const MAX_DIAGNOSTIC_DETAIL_CHARS = 240;

const FORMATTED_ERROR_SYMBOL = Symbol('getChangedPoolsV3Error');

const NON_RETRYABLE_STATUS_CODES = new Set([401, 403, 404]);

const NON_RETRYABLE_PATTERN =
    /\b(unauthorized|forbidden|invalid api key|api key|malformed|invalid address|invalid topic|invalid hex|method not found|unsupported method)\b/i;

const HEAD_SKEW_PATTERN =
    /(unknown block|after last accepted block|block not found|header not found|beyond (the )?(current )?(head|latest|chain ?tip|tip)|exceeds (the )?(current )?(head|latest|chain ?tip|tip)|ahead of (the )?(current )?(head|latest|chain ?tip|tip)|future block|\b(toblock|fromblock)\b[^\n]{0,40}(?:\b(?:greater than|exceeds|after|beyond|ahead of)\b|>)[^\n]{0,30}\b(latest|head|current (?:block|head|tip|height)|chain ?tip|last accepted)\b|requested block[^\n]{0,40}(not found|unavailable|future))/i;

const RANGE_LIMIT_PATTERN =
    /(block range|max(imum)?\s+range|block window|range (is )?too (wide|large)|too many blocks|limited to\b|exceeds? max|exceeded max|more than \d+ (results|logs|blocks)|query returned more than|too many results|log response size|response size exceeded)/i;

export interface GetChangedPoolsV3Options {
    /** Maximum retries for transient head-skew or small-range -32602 errors. Defaults to 3. */
    maxRetries?: number;
    /** Initial backoff delay in ms (doubles on each retry). Defaults to 500. */
    retryDelayMs?: number;
    /** Maximum recursive bisection depth for range halving. Defaults to 14. */
    maxSplitDepth?: number;
    /** Inclusive block span at or below which ambiguous -32602 errors retry instead of splitting. Defaults to 10n. */
    minSplitRange?: bigint;
    /** Optional sleep implementation for testing. */
    sleep?: (ms: number) => Promise<void>;
}

interface RpcErrorInfo {
    code?: number;
    status?: number;
    shortMessage?: string;
    details?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const truncateText = (text: string, maxChars: number): string => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
};

const stripRequestBody = (message: string): string => {
    const requestBodyIndex = message.indexOf('Request body:');
    if (requestBodyIndex === -1) {
        return message;
    }
    const detailsIndex = message.indexOf('Details:', requestBodyIndex);
    if (detailsIndex !== -1) {
        return `${message.slice(0, requestBodyIndex).trim()} ${message.slice(detailsIndex).trim()}`.trim();
    }
    return message.slice(0, requestBodyIndex).trim();
};

const extractRpcErrorInfo = (err: unknown): RpcErrorInfo => {
    const info: RpcErrorInfo = {};

    const inspectNode = (node: unknown) => {
        if (!node || typeof node !== 'object') {
            return;
        }
        const record = node as Record<string, unknown>;
        if (info.code === undefined && typeof record.code === 'number') {
            info.code = record.code;
        }
        if (info.status === undefined && typeof record.status === 'number') {
            info.status = record.status;
        }
        if (info.shortMessage === undefined && typeof record.shortMessage === 'string' && record.shortMessage.trim()) {
            info.shortMessage = record.shortMessage.trim();
        }
        if (typeof record.details === 'string' && record.details.trim()) {
            // Prefer the deepest non-empty details string in viem's cause chain.
            info.details = record.details.trim();
        }
    };

    if (err && typeof err === 'object' && typeof (err as { walk?: unknown }).walk === 'function') {
        (err as { walk: (fn?: (e: unknown) => boolean) => unknown }).walk((node) => {
            inspectNode(node);
            return false;
        });
    } else {
        let current: unknown = err;
        for (let depth = 0; depth < 10 && current; depth++) {
            inspectNode(current);
            if (typeof current === 'object' && 'cause' in current) {
                current = (current as { cause?: unknown }).cause;
            } else {
                break;
            }
        }
    }

    if (!info.details && !info.shortMessage) {
        if (err instanceof Error && err.message) {
            info.details = stripRequestBody(err.message);
        } else if (typeof err === 'string' && err.trim()) {
            info.details = stripRequestBody(err);
        }
    }

    return info;
};

const buildDiagnosticError = (err: unknown, info: RpcErrorInfo, fromBlock: bigint, toBlock: bigint): Error => {
    const blockSpan = toBlock - fromBlock + 1n;
    const meta = [`fromBlock=${fromBlock}`, `toBlock=${toBlock}`, `blocks=${blockSpan}`];
    if (info.code !== undefined) {
        meta.push(`code=${info.code}`);
    }
    if (info.status !== undefined) {
        meta.push(`status=${info.status}`);
    }

    const rawDetail =
        info.details ||
        info.shortMessage ||
        (err instanceof Error ? stripRequestBody(err.message) : String(err || 'Unknown RPC error'));
    const detail = truncateText(rawDetail, MAX_DIAGNOSTIC_DETAIL_CHARS);

    const wrapped = new Error(`getChangedPoolsV3 failed (${meta.join(', ')}): ${detail}`, { cause: err });
    (wrapped as Error & { [FORMATTED_ERROR_SYMBOL]?: boolean })[FORMATTED_ERROR_SYMBOL] = true;
    return wrapped;
};

type ErrorAction = 'non-retryable' | 'head-skew' | 'range-limit' | 'ambiguous-invalid-params';

const classifyRpcError = (info: RpcErrorInfo): ErrorAction => {
    const diagnosticText = [info.details, info.shortMessage].filter(Boolean).join(' ');

    if (info.status !== undefined && NON_RETRYABLE_STATUS_CODES.has(info.status)) {
        return 'non-retryable';
    }
    if (diagnosticText && NON_RETRYABLE_PATTERN.test(diagnosticText)) {
        return 'non-retryable';
    }
    if (info.code === -32005 || (diagnosticText && RANGE_LIMIT_PATTERN.test(diagnosticText))) {
        return 'range-limit';
    }
    if (diagnosticText && HEAD_SKEW_PATTERN.test(diagnosticText)) {
        return 'head-skew';
    }
    if (info.code === -32602) {
        return 'ambiguous-invalid-params';
    }
    return 'non-retryable';
};

/**
 * Extracts pool IDs from PoolBalanceChanged and Swap events changing the pool state.
 * Adaptively bisects block ranges on RPC range-limit / -32602 errors and retries
 * transient head-skew / small-range -32602 rejections with bounded backoff.
 *
 * @param vaultAddress - the address of the vault
 * @param client - the viem client to use
 * @param fromBlock - the inclusive block to start from
 * @param toBlock - the inclusive block to end at
 * @param options - optional retry/bisection tuning parameters
 * @returns - the unique lowercase list of pool addresses that have changed
 */
export const getChangedPoolsV3 = async (
    vaultAddress: string,
    client: ViemClient,
    fromBlock: bigint,
    toBlock: bigint,
    options?: GetChangedPoolsV3Options,
): Promise<string[]> => {
    if (fromBlock > toBlock) {
        return [];
    }

    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const maxSplitDepth = options?.maxSplitDepth ?? DEFAULT_MAX_SPLIT_DEPTH;
    const minSplitRange = options?.minSplitRange ?? DEFAULT_MIN_SPLIT_RANGE;
    const sleep = options?.sleep ?? defaultSleep;

    const fetchRange = async (start: bigint, end: bigint, splitDepth: number): Promise<string[]> => {
        const blockSpan = end - start + 1n;

        for (let attempt = 0; ; attempt++) {
            try {
                const logs = await client.getLogs({
                    address: vaultAddress as `0x${string}`,
                    events,
                    fromBlock: start,
                    toBlock: end,
                });

                const poolIds = new Set<string>();
                for (const log of logs) {
                    const pool = (log as { args?: { pool?: string } }).args?.pool;
                    if (pool) {
                        poolIds.add(pool.toLowerCase());
                    }
                }
                return Array.from(poolIds);
            } catch (err) {
                if (
                    err instanceof Error &&
                    (err as Error & { [FORMATTED_ERROR_SYMBOL]?: boolean })[FORMATTED_ERROR_SYMBOL]
                ) {
                    throw err;
                }

                const info = extractRpcErrorInfo(err);
                const action = classifyRpcError(info);
                const detailForLog = truncateText(info.details || info.shortMessage || '', 200);

                const shouldBisect =
                    end > start &&
                    splitDepth < maxSplitDepth &&
                    (action === 'range-limit' || (action === 'ambiguous-invalid-params' && blockSpan > minSplitRange));

                if (shouldBisect) {
                    const logFn = splitDepth === 0 ? logger.warn : logger.debug;
                    logFn('Bisecting getChangedPoolsV3 block range after RPC error', {
                        fromBlock: start,
                        toBlock: end,
                        blocks: blockSpan,
                        splitDepth,
                        rpcCode: info.code,
                        rpcDetails: detailForLog || undefined,
                    });

                    const mid = (start + end) / 2n;
                    const left = await fetchRange(start, mid, splitDepth + 1);
                    const right = await fetchRange(mid + 1n, end, splitDepth + 1);
                    return Array.from(new Set([...left, ...right]));
                }

                const shouldRetry =
                    attempt < maxRetries &&
                    (action === 'head-skew' ||
                        (action === 'ambiguous-invalid-params' && (blockSpan <= minSplitRange || start === end)));

                if (shouldRetry) {
                    const delayMs = retryDelayMs * 2 ** attempt;
                    const logFn = attempt === 0 ? logger.warn : logger.debug;
                    logFn('Retrying getChangedPoolsV3 after transient RPC error', {
                        fromBlock: start,
                        toBlock: end,
                        blocks: blockSpan,
                        attempt: attempt + 1,
                        maxRetries,
                        delayMs,
                        rpcCode: info.code,
                        rpcDetails: detailForLog || undefined,
                    });
                    if (delayMs > 0) {
                        await sleep(delayMs);
                    }
                    continue;
                }

                throw buildDiagnosticError(err, info, start, end);
            }
        }
    };

    return fetchRange(fromBlock, toBlock, 0);
};

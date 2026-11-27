import {
    Chain as ViemChain,
    createPublicClient,
    http,
    HttpRequestError,
    HttpTransportConfig,
    PublicClient,
    Transport,
} from 'viem';
import { base, mainnet, monad, sepolia } from 'viem/chains';
import { Chain } from '@prisma/client';
import config from '../../config';
import { logger } from '../common/logger';

export type ViemClient = ReturnType<typeof getViemClient>;

// Use this interface for easier mocking
export interface IViemClient {
    multicall: PublicClient['multicall'];
    readContract: PublicClient['readContract'];
}

const NON_RETRYABLE_HTTP_STATUS_CODES = new Set([401, 403, 404]);
const RETRYABLE_RPC_CODES = new Set([-1, -32005, -32603, 429, -32007]);
const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 413, 429, 500, 502, 503, 504]);

/**
 * Preserves non-retryable HTTP statuses (401/403/404) when an RPC endpoint returns
 * a valid JSON-RPC error payload. Viem's http() transport otherwise returns the parsed
 * JSON-RPC error object and drops response.status, causing downstream error handlers to
 * misclassify e.g. HTTP 403 + -32602/-32603/-32005 as a retryable/splittable RPC error.
 */
export const createHttpStatusPreservingOnFetchResponse = (fallbackUrl?: string) => {
    return async (response: Response) => {
        if (response.ok || !NON_RETRYABLE_HTTP_STATUS_CODES.has(response.status)) {
            return;
        }

        let bodyText = '';
        try {
            bodyText = await response.clone().text();
        } catch {
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(bodyText);
        } catch {
            return;
        }

        const rpcError =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed
                ? (parsed as { error?: { code?: unknown; message?: unknown } }).error
                : undefined;

        if (typeof rpcError?.code === 'number' && typeof rpcError?.message === 'string') {
            const httpError = new HttpRequestError({
                url: response.url || fallbackUrl || '',
                status: response.status,
                headers: response.headers,
                details: rpcError.message || response.statusText,
            }) as HttpRequestError & { code?: number };
            httpError.code = rpcError.code;
            throw httpError;
        }
    };
};

const extractTransportHttpStatus = (error: unknown): number | undefined => {
    let status: number | undefined;
    const inspect = (node: unknown) => {
        if (
            status === undefined &&
            node &&
            typeof node === 'object' &&
            'status' in node &&
            typeof (node as { status?: unknown }).status === 'number'
        ) {
            status = (node as { status: number }).status;
        }
    };

    if (error && typeof error === 'object' && typeof (error as { walk?: unknown }).walk === 'function') {
        (error as { walk: (fn: (e: unknown) => boolean) => unknown }).walk((node) => {
            inspect(node);
            return status !== undefined;
        });
    } else {
        inspect(error);
    }
    return status;
};

const shouldRetryTransportError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') {
        return true;
    }
    if ('name' in error && (error as { name?: unknown }).name === 'AbortError') {
        return false;
    }

    const httpStatus = extractTransportHttpStatus(error);
    if (httpStatus !== undefined && NON_RETRYABLE_HTTP_STATUS_CODES.has(httpStatus)) {
        return false;
    }

    if ('code' in error && typeof (error as { code?: unknown }).code === 'number') {
        return RETRYABLE_RPC_CODES.has((error as { code: number }).code);
    }

    if (error instanceof HttpRequestError && error.status !== undefined) {
        return RETRYABLE_HTTP_STATUS_CODES.has(error.status);
    }

    return true;
};

const getTransportRetryDelay = (error: unknown, count: number, retryDelay: number): number => {
    if (error instanceof HttpRequestError) {
        const retryAfter = error.headers?.get('Retry-After');
        if (retryAfter?.match(/\d/)) {
            return Number.parseInt(retryAfter, 10) * 1000;
        }
    }
    return ~~(1 << count) * retryDelay;
};

const sleepWithSignal = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });

/**
 * Wraps viem's http() transport so HTTP 401/403/404 responses preserve their status
 * (even when the body is a valid JSON-RPC error like -32602/-32603/-32005) and never
 * trigger viem transport retries.
 */
export const createRpcHttpTransport = (url?: string, options: HttpTransportConfig = {}): Transport => {
    const preserveHttpStatus = createHttpStatusPreservingOnFetchResponse(url);

    return (params) => {
        const defaultRetryCount = options.retryCount ?? params.retryCount ?? 3;
        const defaultRetryDelay = options.retryDelay ?? 150;

        const baseTransport = http(url, {
            ...options,
            retryCount: 0,
            onFetchResponse: async (response) => {
                await preserveHttpStatus(response);
                await options.onFetchResponse?.(response);
            },
        })(params);

        const request = (async (
            args: Parameters<typeof baseTransport.request>[0],
            overrideOptions?: Parameters<typeof baseTransport.request>[1],
        ) => {
            const effectiveRetryCount = overrideOptions?.retryCount ?? defaultRetryCount;
            const effectiveRetryDelay = overrideOptions?.retryDelay ?? defaultRetryDelay;
            const signal = overrideOptions?.signal;

            for (let count = 0; ; count++) {
                try {
                    return await baseTransport.request(args, { ...overrideOptions, retryCount: 0 });
                } catch (err) {
                    if (signal?.aborted || count >= effectiveRetryCount || !shouldRetryTransportError(err)) {
                        throw err;
                    }
                    const delayMs = getTransportRetryDelay(err, count, effectiveRetryDelay);
                    await sleepWithSignal(delayMs, signal);
                }
            }
        }) as typeof baseTransport.request;

        return {
            ...baseTransport,
            config: {
                ...baseTransport.config,
                retryCount: defaultRetryCount,
                retryDelay: defaultRetryDelay,
            },
            request,
        };
    };
};

const chain2ViemChain: Partial<Record<Chain, ViemChain>> = {
    [Chain.MAINNET]: mainnet,
    [Chain.MONAD]: monad,
    [Chain.SEPOLIA]: sepolia,
    [Chain.BASE]: base,
};

export const getViemClient = (chain: Chain, options?: { multicallBatch?: boolean; jsonRpcBatch?: boolean }) => {
    return createPublicClient({
        chain: chain2ViemChain[chain],
        batch: options?.multicallBatch ? { multicall: true } : undefined,
        transport: createRpcHttpTransport(config[chain]?.rpcUrl, {
            batch: options?.jsonRpcBatch || undefined,
            onFetchRequest(request) {
                if (process.env.DEBUG) {
                    const reader = request.body?.getReader();
                    if (!reader) {
                        return;
                    }
                    let body = '';

                    reader
                        .read()
                        .then(function processText({ done, value }) {
                            if (done) {
                                return;
                            }
                            // value for fetch streams is a Uint8Array
                            body += value;
                            reader.read().then(processText);
                        })
                        .then(() => {
                            const json = JSON.parse(
                                body
                                    .split(',')
                                    .map((code) => String.fromCharCode(parseInt(code, 10)))
                                    .join(''),
                            );
                            logger.debug('Viem RPC request', {
                                id: json['id'],
                                method: json['method'],
                                bytes: body.length,
                                to: json['params']?.[0]?.['to'],
                            });
                        });
                }
            },
        }),
    });
};

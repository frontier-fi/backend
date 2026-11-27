import { Chain as ViemChain, createPublicClient, http, HttpRequestError, PublicClient } from 'viem';
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

/**
 * Preserves non-retryable HTTP statuses (401/403/404) when an RPC endpoint returns
 * a valid JSON-RPC error payload. Viem's http() transport otherwise returns the parsed
 * JSON-RPC error object and drops response.status, causing downstream error handlers to
 * misclassify e.g. HTTP 403 + -32602 as a generic invalid-params error.
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
        transport: http(config[chain]?.rpcUrl, {
            batch: options?.jsonRpcBatch || undefined,
            onFetchResponse: createHttpStatusPreservingOnFetchResponse(config[chain]?.rpcUrl),
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

import { Chain as ViemChain, createPublicClient, http, PublicClient } from 'viem';
import { base, mainnet, sepolia } from 'viem/chains';
import { Chain } from '@prisma/client';
import config from '../../config';

export type ViemClient = ReturnType<typeof getViemClient>;

// Use this interface for easier mocking
export interface IViemClient {
    multicall: PublicClient['multicall'];
    readContract: PublicClient['readContract'];
}

const chain2ViemChain: Partial<Record<Chain, ViemChain>> = {
    [Chain.MAINNET]: mainnet,
    [Chain.SEPOLIA]: sepolia,
    [Chain.BASE]: base,
};

export const getViemClient = (chain: Chain, options?: { multicallBatch?: boolean; jsonRpcBatch?: boolean }) => {
    return createPublicClient({
        chain: chain2ViemChain[chain],
        batch: options?.multicallBatch ? { multicall: true } : undefined,
        transport: http(config[chain]?.rpcUrl, {
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
                            try {
                                console.log(json['id'], json['method'], body.length, json['params'][0]['to']);
                            } catch (e) {
                                console.log(json['id'], json['method'], body.length);
                            }
                        });
                }
            },
        }),
    });
};

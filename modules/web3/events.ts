import { Interface, LogDescription } from 'ethers';
import { chunk } from 'lodash';

export type DecodedEventLog = {
    address: string;
    topics?: readonly string[];
    data?: string;
    args?: Record<string, unknown>;
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

    console.log(topics);

    const range = toBlock - fromBlock;
    const numBatches = Math.ceil(range / rpcMaxBlockRange);

    const promises: Promise<DecodedEventLog[]>[] = [];

    for (let i = 0; i < numBatches; i++) {
        const from = fromBlock + (i > 0 ? 1 : 0) + i * rpcMaxBlockRange;
        const to = Math.min(fromBlock + (i + 1) * rpcMaxBlockRange, toBlock);

        const addressChunks = chunk(addresses, maxAddresses);

        for (const addressChunk of addressChunks) {
            const promise = fetchLogs(from, to, addressChunk, topics, rpcUrl).catch((e: any) => {
                // Ankr RPC returns error if block range is too wide
                if (e.includes && e.includes('block range is too wide')) {
                    return getEvents(from, to, addressChunk, topics, rpcUrl, rpcMaxBlockRange / 2);
                }

                // Infura returns 'more than 10000 results' error if block range is too wide
                // error format:
                // "query returned more than 10000 results. Try with this block range [0x30CE171, 0x30CE1C9]."
                if (e.includes && e.includes('query returned more than 10000 results')) {
                    const range = e
                        .match(/\[([0-9a-fA-F, x]+)\]/)
                        .pop()
                        .split(', ')
                        .map((hex: string) => parseInt(hex, 16));

                    return getEvents(from, to, addressChunk, topics, rpcUrl, range[1] - range[0]);
                }

                // Alchemy / tenderly / gateway.fm rate limit
                if (
                    e.includes &&
                    (e.includes('Your app has exceeded its compute units per second capacity') ||
                        e.includes('rate limit exceeded') ||
                        e.includes('Total number of requests exceeded'))
                ) {
                    return new Promise<DecodedEventLog[]>((resolve) => {
                        setTimeout(() => {
                            resolve(getEvents(from, to, addressChunk, topics, rpcUrl, rpcMaxBlockRange));
                        }, 1000);
                    });
                }

                // Allnodes addresses size limit
                if (e.includes && e.includes('specify less number of addresses')) {
                    return new Promise<DecodedEventLog[]>((resolve) => {
                        setTimeout(() => {
                            resolve(
                                getEvents(
                                    from,
                                    to,
                                    addressChunk,
                                    topics,
                                    rpcUrl,
                                    rpcMaxBlockRange,
                                    undefined,
                                    maxAddresses / 2,
                                ),
                            );
                        }, 1000);
                    });
                }

                // Handle missing block in the RPC logs by retrying the request after 1s
                if (e.includes && (e.includes('unknown block') || e.includes('after last accepted block'))) {
                    console.log(`Retrying getEvents for block ${from}-${to} on ${rpcUrl}`);
                    return new Promise<DecodedEventLog[]>((resolve) => {
                        setTimeout(() => {
                            resolve(getEvents(from, to, addressChunk, topics, rpcUrl, rpcMaxBlockRange));
                        }, 1000);
                    });
                }

                return Promise.reject(e);
            });

            promises.push(promise);
        }
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

    return fetch(rpcUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    })
        .then(
            (response) =>
                response.json() as Promise<
                    { result: DecodedEventLog[] } | { error: { code: string; message: string } }
                >,
        )
        .then((response) => {
            if ('error' in response) {
                return Promise.reject(response.error.message);
            }

            // gateway.fm returns errors in results
            if ('code' in response.result) {
                return Promise.reject((response.result as any)['message']);
            }

            return response.result;
        });

    // Fetching logs with Viem
    // viemClient.getLogs({
    //     address: addresses,
    //     event: parseAbiItem('event Transfer(address indexed, address indexed, uint256)'),
    //     fromBlock: BigInt(from),
    //     toBlock: BigInt(to),
    // })
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

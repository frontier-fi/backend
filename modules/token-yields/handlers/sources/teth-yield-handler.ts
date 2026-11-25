import { TokenYieldHandler } from '../../types';

const url = 'https://api.treehouse.finance/rate/mey';

const fetchJson = async <T>(url: string, timeoutMs = 20_000): Promise<T> => {
    // The signal stays attached to the response, so the deadline also covers reading the body
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
        throw new Error(`${url} responded with ${response.status}`);
    }
    return (await response.json()) as T;
};

// The apr config needs to be custom made as the resulting value
// is equal to Lido's wstETH APR plus the data from the below query.
export const treehouseYieldHandler: TokenYieldHandler = async (config: { address: string }) => {
    try {
        const { key, message, data } = await fetchJson<{ key: string; message: string; data: string }>(url);
        if (key !== 'SUCCESS') {
            throw new Error('Treehouse API failed: ' + message);
        }

        // Get Lido wstETH APR
        const {
            data: { smaApr },
        } = await fetchJson<{ data: { smaApr: number } }>('https://eth-api.lido.fi/v1/protocol/steth/apr/sma');

        return [{ address: config.address, apr: (parseFloat(data) + smaApr) / 100 }];
    } catch (error) {
        throw Error(`Treehouse tETH IB APR handler failed: ${(error as Error).message}`);
    }
};

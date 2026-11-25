import { JSONPath } from 'jsonpath-plus';
import { TokenYieldHandler, TokenYieldHttpFetchConfig } from '../../types';

const fetchJsonWithTimeout = async (
    url: string,
    options: RequestInit = {},
    _skipSSL = false,
    timeoutMs: number = 20000,
): Promise<any> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // The body is read inside the race, so the timeout also covers a response that stalls after its headers
    const fetchPromise = fetch(url, {
        ...options,
        signal: controller.signal,
    }).then((response) => response.json());
    // Detached so a late abort rejection is not unhandled when the timeout wins the race
    fetchPromise.catch(() => {});

    let onAbort: (() => void) | undefined;
    // Timeout promise - needed to handle bun edge case that doesn't throw when fetch is aborted
    const timeoutPromise = new Promise((_, reject) => {
        onAbort = () => {
            reject(new Error(`timed out after ${timeoutMs}ms`));
        };
        controller.signal.addEventListener('abort', onAbort);
    });

    try {
        const json = await Promise.race([fetchPromise, timeoutPromise]);
        clearTimeout(timeoutId);
        return json;
    } catch (error: any) {
        clearTimeout(timeoutId);
        throw `${url} ${error.message}`;
    } finally {
        // Cleanup listener in all cases to prevent potential mem leaks
        if (onAbort) {
            controller.signal.removeEventListener('abort', onAbort);
        }
    }
};

const extract = (json: unknown, config: TokenYieldHttpFetchConfig): [string, unknown][] =>
    config.extractors.flatMap((ex) => {
        if (ex.type === 'path') {
            const raw = JSONPath({ path: ex.path, json, wrap: false });
            return [[ex.token, raw]];
        }
        if (ex.type === 'enumerate') {
            const values = JSONPath({ path: ex.path, json, wrap: false });
            return Array.isArray(values) ? values.map(ex.entries) : [];
        }
        return [];
    });

const transform = (entries: [string, unknown][], config: TokenYieldHttpFetchConfig) =>
    Promise.all(entries.map(async ([key, value]) => ({ address: key, apr: await normalizeValue(value, config) })));

const normalizeValue = async (value: any, { url, average, scale, convert }: TokenYieldHttpFetchConfig) => {
    if (value === undefined) {
        throw `value parsing error ${url}`;
    }

    if (Array.isArray(value)) {
        if (average) {
            value = value.reduce((a: number, b: number) => Number(a) + Number(b), 0) / value.length;
        } else {
            value = value[0];
        }
    }

    if (scale) value = value / scale;

    if (convert) value = await convert(parseFloat(value));

    return parseFloat(value);
};

export const httpTokenYieldHandler: TokenYieldHandler = async (config: TokenYieldHttpFetchConfig) => {
    const json = await fetchJsonWithTimeout(
        config.url,
        {
            method: config.method ?? (config.body ? 'POST' : 'GET'),
            headers: config.headers,
            ...(config.body && { body: config.body }),
        },
        config.skipSSL,
    );
    try {
        return transform(extract(json, config), config);
    } catch (e: any) {
        throw `http-yield-handler ${e.message} ${config.url}`;
    }
};

import { ADMIN_API_KEY, GRAPHQL_URL } from './config';
import { serverLogs } from './server';

export type GraphqlError = {
    message: string;
    extensions?: { code?: string };
};

export type GraphqlResult<T> = {
    status: number;
    body: {
        data?: T;
        errors?: GraphqlError[];
    };
    raw: string;
};

export async function graphql<T>(
    query: string,
    options?: {
        admin?: boolean;
        variables?: Record<string, unknown>;
        headers?: Record<string, string>;
        timeoutMs?: number;
    },
): Promise<GraphqlResult<T>> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...options?.headers,
    };
    if (options?.admin) headers.AdminApiKey = ADMIN_API_KEY;

    const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables: options?.variables ?? {} }),
        signal: AbortSignal.timeout(options?.timeoutMs ?? 480_000),
    });
    const raw = await response.text();
    let body: GraphqlResult<T>['body'];
    try {
        body = JSON.parse(raw) as GraphqlResult<T>['body'];
    } catch {
        body = { errors: [{ message: raw }] };
    }
    return { status: response.status, body, raw };
}

export function data<T>(result: GraphqlResult<T>): T {
    if (result.body.errors?.length) {
        throw new Error(`${result.body.errors.map((error) => error.message).join('\n')}\n${serverLogs()}`);
    }
    if (result.body.data === undefined) {
        throw new Error(`GraphQL response had no data (${result.status})\n${result.raw}\n${serverLogs()}`);
    }
    return result.body.data;
}

export function expectRejectedAddress(result: GraphqlResult<unknown>): void {
    const error = result.body.errors?.[0];
    const rejected =
        result.status === 400 && error?.extensions?.code === 'BAD_USER_INPUT' && /invalid address/i.test(error.message);
    if (!rejected) {
        throw new Error(
            `Expected a 400 BAD_USER_INPUT for a bad checksum\n${result.status} ${result.raw}\n${serverLogs()}`,
        );
    }
}

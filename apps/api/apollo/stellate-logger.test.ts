import { ApolloServer, HeaderMap } from '@apollo/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../gql/generated-schema-ast';
import { backgroundFetch, stellateLoggerPlugin } from './stellate-logger';

const PRODUCTION = { NODE_ENV: 'production', SOR_INSTANCE: false, STELLATE_LOGGING_TOKEN: 'logging-token' };

describe('stellateLoggerPlugin', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        ['outside production', { ...PRODUCTION, NODE_ENV: 'staging' }],
        ['on the SOR instance', { ...PRODUCTION, SOR_INSTANCE: true }],
        ['without a token', { ...PRODUCTION, STELLATE_LOGGING_TOKEN: undefined }],
    ])('is off %s', (_case, settings) => {
        expect(stellateLoggerPlugin(settings)).toBeUndefined();
    });

    it('resolves before the upload finishes', async () => {
        const upload = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));

        const response = await backgroundFetch('https://frontier-api.stellate.sh/log', { method: 'POST' });

        expect(response.status).toBe(202);
        expect(upload).toHaveBeenCalledWith(
            'https://frontier-api.stellate.sh/log',
            expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
        );
    });

    it('logs direct requests without waiting for Stellate, and skips requests from the edge', async () => {
        const upload = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
        const server = new ApolloServer({
            typeDefs: schema,
            resolvers: { Query: { poolGetPoolsCount: () => 1 } },
            plugins: [stellateLoggerPlugin(PRODUCTION)!],
        });
        await server.start();

        const run = (headers: [string, string][]) =>
            server.executeOperation({
                query: 'query Count($user: String) { poolGetPoolsCount(where: { userAddress: $user }) }',
                operationName: 'Count',
                variables: { user: '0x0000000000000000000000000000000000000001' },
                http: { method: 'POST', headers: new HeaderMap(headers), search: '', body: {} },
            });
        const logCalls = () => upload.mock.calls.filter(([url]) => String(url).endsWith('/log'));

        const direct = await run([['user-agent', 'vitest']]);
        expect(direct.body.kind === 'single' && direct.body.singleResult.data).toEqual({ poolGetPoolsCount: 1 });
        expect(logCalls()).toHaveLength(1);
        const [url, init] = logCalls()[0];
        expect(url).toBe('https://frontier-api.stellate.sh/log');
        expect((init?.headers as Record<string, string>)['Stellate-Logging-Token']).toBe('logging-token');
        const payload = JSON.parse(String(init?.body));
        expect(payload).toMatchObject({ operationName: 'Count', userAgent: 'vitest' });
        expect(payload.variables).toBeUndefined();
        expect(typeof payload.variableHash).toBe('number');

        await run([['gcdn-request-id', 'edge-request']]);
        expect(logCalls()).toHaveLength(1);

        await server.stop();
    });
});

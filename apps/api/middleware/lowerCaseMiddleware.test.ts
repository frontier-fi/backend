import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jsonErrorHandler } from './errorHandler';
import { lowerCaseMiddleware } from './lowerCaseMiddleware';

const VALID_CHECKSUM = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const BAD_CHECKSUM = '0xfff9976782d46CC05630D1f6eBAb18b2324d6B14';

describe('lowerCaseMiddleware with the JSON error handler', () => {
    const resolver = vi.fn((_parent: unknown, args: { id: string; userAddress?: string; chainId?: string }) =>
        args.userAddress ? `${args.id}:${args.userAddress}` : args.id,
    );
    let apollo: ApolloServer;
    let server: Server;
    let baseUrl: string;

    async function post(path: string, body: string) {
        const response = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
        });
        return {
            status: response.status,
            contentType: response.headers.get('content-type'),
            body: (await response.json()) as {
                data?: { poolGetPool: string };
                errors?: { message: string; extensions?: { code?: string } }[];
            },
        };
    }

    const graphql = (query: string, variables?: Record<string, unknown>) =>
        post('/graphql', JSON.stringify({ query, variables }));

    beforeAll(async () => {
        apollo = new ApolloServer({
            typeDefs: 'type Query { poolGetPool(id: String!, chainId: String, userAddress: String): String }',
            resolvers: { Query: { poolGetPool: resolver } },
        });
        await apollo.start();

        const app = express();
        app.use(lowerCaseMiddleware);
        app.use('/graphql', express.json(), expressMiddleware(apollo));
        app.post('/crash', () => {
            throw new Error('database password in a stack trace');
        });
        app.post('/too-large', () => {
            throw Object.assign(new Error('request entity too large'), { status: 413 });
        });
        app.use(jsonErrorHandler);

        server = await new Promise<Server>((resolve) => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        await apollo.stop();
        vi.restoreAllMocks();
    });

    it('stores a valid checksum lowercase', async () => {
        const result = await graphql('query ($id: String!) { poolGetPool(id: $id) }', { id: VALID_CHECKSUM });

        expect(result.body.data?.poolGetPool).toBe(VALID_CHECKSUM.toLowerCase());
    });

    it('normalizes and validates arbitrarily named GraphQL variables used in id and address arguments', async () => {
        const valid = await graphql(
            'query ($pool: String!, $user: String) { poolGetPool(id: $pool, userAddress: $user) }',
            { pool: VALID_CHECKSUM, user: VALID_CHECKSUM },
        );
        expect(valid.body.data?.poolGetPool).toBe(`${VALID_CHECKSUM.toLowerCase()}:${VALID_CHECKSUM.toLowerCase()}`);

        const badPool = await graphql('query ($pool: String!) { poolGetPool(id: $pool) }', { pool: BAD_CHECKSUM });
        expect(badPool.status).toBe(400);
        expect(badPool.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

        const malformedAddress = await graphql('query ($user: String) { poolGetPool(id: "0x1", userAddress: $user) }', {
            user: '0x1234',
        });
        expect(malformedAddress.status).toBe(400);
        expect(malformedAddress.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });

    it('rejects a bad checksum in variables with BAD_USER_INPUT', async () => {
        resolver.mockClear();

        const result = await graphql('query ($id: String!) { poolGetPool(id: $id) }', { id: BAD_CHECKSUM });

        expect(result.status).toBe(400);
        expect(result.contentType).toMatch(/application\/json/);
        expect(result.body.errors?.[0]).toEqual({
            message: `Invalid address ${BAD_CHECKSUM}`,
            extensions: { code: 'BAD_USER_INPUT' },
        });
        expect(resolver).not.toHaveBeenCalled();
    });

    it('rejects a bad checksum written into the query', async () => {
        const result = await graphql(`{ poolGetPool(id: "${BAD_CHECKSUM}") }`);

        expect(result.status).toBe(400);
        expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });

    it('lowercases an id that is not an address and leaves chainId alone', async () => {
        const result = await graphql('{ poolGetPool(id: "0xABC-Event", chainId: "SEPOLIA") }');

        expect(result.body.data?.poolGetPool).toBe('0xabc-event');
        expect(resolver).toHaveBeenLastCalledWith(
            undefined,
            { id: '0xabc-event', chainId: 'SEPOLIA' },
            expect.anything(),
            expect.anything(),
        );
    });

    it('lets Apollo report a syntax error', async () => {
        const result = await graphql('{ poolGetPool(id: "0x1" ');

        expect(result.status).toBe(400);
        expect(result.body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_PARSE_FAILED');
    });

    it('forwards body-parser 400 and 413 errors to jsonErrorHandler instead of swallowing them', async () => {
        const invalidJson = await post('/graphql', '{not-json');
        expect(invalidJson.status).toBe(400);
        expect(invalidJson.body.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');

        const oversizedBody = JSON.stringify({ query: `{ poolGetPool(id: "${'a'.repeat(110_000)}") }` });
        const tooLarge = await post('/graphql', oversizedBody);
        expect(tooLarge.status).toBe(413);
        expect(tooLarge.body.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');
    });

    it('answers an unexpected error with JSON and no details', async () => {
        const result = await post('/crash', '{}');

        expect(result.status).toBe(500);
        expect(result.contentType).toMatch(/application\/json/);
        expect(result.body.errors).toEqual([
            { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
        ]);
    });

    it('keeps the status and message of a client error', async () => {
        const result = await post('/too-large', '{}');

        expect(result.status).toBe(413);
        expect(result.body.errors).toEqual([
            { message: 'request entity too large', extensions: { code: 'BAD_REQUEST' } },
        ]);
    });
});

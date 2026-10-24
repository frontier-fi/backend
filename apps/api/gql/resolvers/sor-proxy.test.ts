import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { ApolloServer } from '@apollo/server';
import { FieldNode, Kind, OperationDefinitionNode, parse } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../generated-schema-ast';
import { proxySorRequest } from './sor.resolvers';

interface ForwardedRequest {
    query: string;
    variables: Record<string, unknown>;
    operationName: string;
}

const QUOTE = { returnAmount: '1.5', swaps: [{ poolId: '0xpool', amount: '10' }] };
const QUOTE_ARGS = 'chain: SEPOLIA, tokenIn: "0x1", tokenOut: "0x2", swapType: EXACT_IN';

function rootFields(query: string): FieldNode[] {
    const operation = parse(query).definitions.find(
        (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
    );
    return (operation?.selectionSet.selections ?? []) as FieldNode[];
}

describe('proxySorRequest', () => {
    const forwarded: ForwardedRequest[] = [];
    let sorError: string | undefined;
    let sor: Server;
    let api: ApolloServer;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.post('/graphql', (req, res) => {
            forwarded.push(req.body);
            res.json(sorError ? { errors: [{ message: sorError }] } : { data: { sorGetSwapPaths: QUOTE } });
        });
        sor = await new Promise<Server>((resolve) => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        const sorUrl = `http://127.0.0.1:${(sor.address() as AddressInfo).port}/graphql`;

        api = new ApolloServer({
            typeDefs: schema,
            resolvers: {
                Query: {
                    sorGetSwapPaths: (_parent, args, _context, info) =>
                        proxySorRequest(sorUrl, args, info, new AbortController()),
                    poolGetPools: () => [],
                    poolGetPoolsCount: () => 3,
                },
            },
        });
        await api.start();
    });

    afterAll(async () => {
        await api.stop();
        await new Promise((resolve) => sor.close(resolve));
    });

    beforeEach(() => {
        forwarded.length = 0;
        sorError = undefined;
    });

    async function execute(query: string, variables?: Record<string, unknown>) {
        const response = await api.executeOperation({ query, variables });
        if (response.body.kind !== 'single') throw new Error('Expected a single result');
        return response.body.singleResult;
    }

    it('forwards each aliased copy on its own, without the other root fields', async () => {
        const result = await execute(`{
            a: sorGetSwapPaths(${QUOTE_ARGS}, swapAmount: "1") { returnAmount }
            b: sorGetSwapPaths(${QUOTE_ARGS}, swapAmount: "2") { returnAmount }
            c: sorGetSwapPaths(${QUOTE_ARGS}, swapAmount: "3") { returnAmount }
            poolGetPoolsCount
        }`);

        expect(result.errors).toBeUndefined();
        expect(result.data).toEqual({
            a: { returnAmount: '1.5' },
            b: { returnAmount: '1.5' },
            c: { returnAmount: '1.5' },
            poolGetPoolsCount: 3,
        });
        expect(forwarded).toHaveLength(3);
        for (const request of forwarded) {
            const fields = rootFields(request.query);
            expect(fields.map((field) => field.name.value)).toEqual(['sorGetSwapPaths']);
            expect(fields[0].alias).toBeUndefined();
        }
        const amounts = forwarded.map((request) => request.query.match(/swapAmount: "(\d)"/)?.[1]).sort();
        expect(amounts).toEqual(['1', '2', '3']);
    });

    it('sends the arguments as literals, whatever the client named its variables', async () => {
        const result = await execute(
            `query Quote($amount: AmountHumanReadable!, $hooks: Boolean!, $pool: String!) {
                sorGetSwapPaths(${QUOTE_ARGS}, swapAmount: $amount, considerPoolsWithHooks: $hooks, poolIds: [$pool]) {
                    returnAmount
                }
            }`,
            { amount: '0.01', hooks: false, pool: '0xpool' },
        );

        expect(result.errors).toBeUndefined();
        expect(forwarded[0].variables).toEqual({});
        expect(forwarded[0].query).toContain('swapAmount: "0.01"');
        expect(forwarded[0].query).toContain('considerPoolsWithHooks: false');
        expect(forwarded[0].query).toContain('poolIds: ["0xpool"]');
        expect(forwarded[0].query).not.toContain('$');
    });

    it('forwards only the fragments and variables its selection uses, without aliases', async () => {
        const result = await execute(
            `query Quote($withSwaps: Boolean!) {
                quote: sorGetSwapPaths(${QUOTE_ARGS}, swapAmount: "1") {
                    amount: returnAmount
                    ...Swaps @include(if: $withSwaps)
                }
                poolGetPools { ...PoolFields }
            }
            fragment Swaps on GqlSorGetSwapPaths { swaps { pool: poolId } }
            fragment PoolFields on GqlPoolMinimal { id }`,
            { withSwaps: true },
        );

        expect(result.errors).toBeUndefined();
        expect(result.data).toEqual({ quote: { amount: '1.5', swaps: [{ pool: '0xpool' }] }, poolGetPools: [] });
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0].variables).toEqual({ withSwaps: true });
        expect(forwarded[0].query).toContain('fragment Swaps on GqlSorGetSwapPaths');
        expect(forwarded[0].query).not.toContain('PoolFields');
        expect(forwarded[0].query).not.toMatch(/\b(quote|amount|pool):/);
    });

    it('turns an error from the SOR instance into an error on the field', async () => {
        sorError = 'no paths';

        const result = await execute(`{ sorGetSwapPaths(${QUOTE_ARGS}, swapAmount: "1") { returnAmount } }`);

        expect(result.errors?.[0]?.message).toBe('Request failed: no paths');
    });
});

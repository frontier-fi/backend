import { buildSchema } from 'graphql';
import type { Config, EdgeRequest } from 'stellate';
import { beforeAll, describe, expect, it } from 'vitest';
import { STELLATE_SERVICE } from './apps/api/apollo/stellate-logger';
import { schema } from './apps/api/gql/generated-schema-ast';
import { ORIGIN_SECRET_HEADER } from './apps/api/middleware/originSecret';

type RateLimits = (req: Pick<EdgeRequest, 'rootFields'>) => ({ name: string } | null)[];

describe('stellate config', () => {
    let config: Config['config'];

    beforeAll(async () => {
        process.env.STELLATE_ORIGIN_SECRET = 'origin-secret';
        config = (await import('./stellate')).default.config;
    });

    it('gives every query in the schema exactly one cache rule', () => {
        const queries = Object.keys(buildSchema(schema).getQueryType()!.getFields()).sort();
        const cached = (config.rules ?? []).flatMap((rule) => {
            const types = rule.types as Record<string, string[]>;
            return types.Query;
        });

        expect([...cached].sort()).toEqual(queries);
    });

    it('sends the header the API checks', () => {
        expect(config.headers).toEqual({ [ORIGIN_SECRET_HEADER]: 'origin-secret' });
    });

    it('names the service the logger plugin reports to', () => {
        expect(config.name).toBe(STELLATE_SERVICE);
    });

    it('limits swap quotes separately, with a function that works on its own at the edge', () => {
        const rateLimits = new Function(`return (${(config.rateLimits as RateLimits).toString()})`)() as RateLimits;
        const names = (fields: string[]) =>
            rateLimits({ rootFields: fields.map((name) => ({ name, alias: null, args: {} })) })
                .filter((rule) => rule !== null)
                .map((rule) => rule!.name);

        expect(names(['poolGetPools'])).toEqual(['Requests per IP']);
        expect(names(['sorGetSwapPaths'])).toEqual(['Requests per IP', 'Swap quotes per IP']);
    });
});

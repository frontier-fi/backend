import { Kind } from 'graphql';
import { describe, expect, it } from 'vitest';
import { resolvers } from '../resolvers';

describe('Date scalar resolver', () => {
    it('is registered at the top level of resolvers and serializes/parses ISO dates', () => {
        const dateScalar = resolvers.Date;
        expect(dateScalar).toBeDefined();

        const sample = new Date('2026-10-27T00:00:00.000Z');
        expect(dateScalar!.serialize(sample)).toBe('2026-10-27T00:00:00.000Z');
        expect(dateScalar!.serialize('not-a-date' as unknown as Date)).toBeNull();

        expect(dateScalar!.parseValue('2026-10-27T00:00:00.000Z')).toEqual(sample);
        expect(dateScalar!.parseValue(123)).toBeNull();

        expect(dateScalar!.parseLiteral({ kind: Kind.STRING, value: '2026-10-27T00:00:00.000Z' }, {})).toEqual(sample);
        expect(dateScalar!.parseLiteral({ kind: Kind.INT, value: '123' }, {})).toBeNull();
    });
});

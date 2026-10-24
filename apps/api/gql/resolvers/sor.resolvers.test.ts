import { afterEach, describe, expect, it, vi } from 'vitest';
import { sorProxyUrl } from './sor.resolvers';

describe('sorProxyUrl', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('quotes in process on the SOR instance', () => {
        expect(sorProxyUrl({ SOR_INSTANCE: true, SOR_SERVICE_URL: 'http://sor:8080/graphql', PORT: 8080 })).toBe(
            undefined,
        );
    });

    it('quotes in process when no SOR service is configured', () => {
        expect(sorProxyUrl({ SOR_INSTANCE: false, PORT: 4000 })).toBe(undefined);
        expect(sorProxyUrl({ SOR_INSTANCE: false, SOR_SERVICE_URL: '', PORT: 4000 })).toBe(undefined);
    });

    it('proxies to a separate SOR service', () => {
        expect(sorProxyUrl({ SOR_INSTANCE: false, SOR_SERVICE_URL: 'http://sor:8080/graphql', PORT: 8080 })).toBe(
            'http://sor:8080/graphql',
        );
        expect(sorProxyUrl({ SOR_INSTANCE: false, SOR_SERVICE_URL: 'http://localhost:4001/graphql', PORT: 4000 })).toBe(
            'http://localhost:4001/graphql',
        );
    });

    it.each([
        ['http://localhost:4000/graphql', 4000],
        ['http://127.0.0.1:4000/graphql', 4000],
        ['http://0.0.0.0:4000/graphql', 4000],
        ['http://[::1]:4000/graphql', 4000],
        ['http://localhost/graphql', 80],
    ])('quotes in process instead of proxying to itself at %s', (url, port) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(sorProxyUrl({ SOR_INSTANCE: false, SOR_SERVICE_URL: url, PORT: port })).toBe(undefined);
        expect(warn).toHaveBeenCalledOnce();
    });
});

import { afterEach, describe, expect, it } from 'vitest';
import { withDefaultConnectionParams } from './prisma-client';

const BASE_URL = 'postgresql://frontier:secret@db.internal:25060/frontier?sslmode=require';

describe('withDefaultConnectionParams', () => {
    const originalEnv = {
        WORKER: process.env.WORKER,
        SCHEDULER: process.env.SCHEDULER,
        SOR_INSTANCE: process.env.SOR_INSTANCE,
    };

    function restoreEnv() {
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }

    afterEach(() => {
        restoreEnv();
    });

    it('defaults api instances to connection_limit=5 and pool_timeout=20', () => {
        delete process.env.WORKER;
        delete process.env.SCHEDULER;
        process.env.SOR_INSTANCE = 'false';

        const url = new URL(withDefaultConnectionParams(BASE_URL));
        expect(url.searchParams.get('connection_limit')).toBe('5');
        expect(url.searchParams.get('pool_timeout')).toBe('20');
        expect(url.searchParams.get('sslmode')).toBe('require');
    });

    it('defaults worker instances to connection_limit=6 even when co-located with scheduler', () => {
        process.env.WORKER = 'true';
        process.env.SCHEDULER = 'true';
        delete process.env.SOR_INSTANCE;

        const url = new URL(withDefaultConnectionParams(BASE_URL));
        expect(url.searchParams.get('connection_limit')).toBe('6');
        expect(url.searchParams.get('pool_timeout')).toBe('20');
    });

    it('defaults sor instances to connection_limit=2', () => {
        delete process.env.WORKER;
        delete process.env.SCHEDULER;
        process.env.SOR_INSTANCE = 'true';

        const url = new URL(withDefaultConnectionParams(BASE_URL));
        expect(url.searchParams.get('connection_limit')).toBe('2');
        expect(url.searchParams.get('pool_timeout')).toBe('20');
    });

    it('defaults standalone scheduler instances to connection_limit=2', () => {
        delete process.env.WORKER;
        process.env.SCHEDULER = 'true';
        delete process.env.SOR_INSTANCE;

        const url = new URL(withDefaultConnectionParams(BASE_URL));
        expect(url.searchParams.get('connection_limit')).toBe('2');
        expect(url.searchParams.get('pool_timeout')).toBe('20');
    });

    it('honors explicit connectionLimit argument over URL and env defaults', () => {
        process.env.WORKER = 'true';
        const urlWithLimit = `${BASE_URL}&connection_limit=10`;

        const url = new URL(withDefaultConnectionParams(urlWithLimit, 1, 15));
        expect(url.searchParams.get('connection_limit')).toBe('1');
        expect(url.searchParams.get('pool_timeout')).toBe('15');
    });

    it('preserves existing connection_limit and pool_timeout query params when not overridden', () => {
        process.env.WORKER = 'true';
        const customUrl = `${BASE_URL}&connection_limit=12&pool_timeout=30`;

        const url = new URL(withDefaultConnectionParams(customUrl));
        expect(url.searchParams.get('connection_limit')).toBe('12');
        expect(url.searchParams.get('pool_timeout')).toBe('30');
    });

    it('returns invalid URLs unchanged', () => {
        expect(withDefaultConnectionParams('not-a-valid-url')).toBe('not-a-valid-url');
    });
});

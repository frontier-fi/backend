import { describe, expect, it } from 'vitest';
import { BoundedLruCache } from './bounded-cache';

describe('BoundedLruCache', () => {
    it('evicts oldest entries by maxEntries and tracks entries and bytes accurately', () => {
        const cache = new BoundedLruCache<string>({ maxBytes: 1_000, maxEntries: 2 });

        cache.setSync('a', '1234'); // 4 bytes
        cache.setSync('b', '123456'); // 6 bytes
        expect(cache.entries).toBe(2);
        expect(cache.bytes).toBe(10);

        // Touch 'a' so 'b' becomes LRU
        expect(cache.getSync('a')).toBe('1234');

        cache.setSync('c', '12'); // 2 bytes -> evicts 'b'
        expect(cache.getSync('b')).toBeUndefined();
        expect(cache.getSync('a')).toBe('1234');
        expect(cache.getSync('c')).toBe('12');
        expect(cache.entries).toBe(2);
        expect(cache.bytes).toBe(6);

        // Overwriting updates byte count cleanly
        cache.setSync('a', '12345678'); // 4 -> 8 bytes
        expect(cache.bytes).toBe(10);

        expect(cache.deleteSync('a')).toBe(true);
        expect(cache.deleteSync('a')).toBe(false);
        expect(cache.entries).toBe(1);
        expect(cache.bytes).toBe(2);

        cache.clear();
        expect(cache.entries).toBe(0);
        expect(cache.bytes).toBe(0);
    });

    it('evicts oldest entries when maxBytes is exceeded', () => {
        const cache = new BoundedLruCache<string>({ maxBytes: 10 });

        cache.setSync('a', '12345'); // 5 bytes
        cache.setSync('b', '12345'); // 5 bytes
        expect(cache.entries).toBe(2);
        expect(cache.bytes).toBe(10);

        cache.setSync('c', '123456'); // 6 bytes -> evicts 'a' and 'b'
        expect(cache.getSync('a')).toBeUndefined();
        expect(cache.getSync('b')).toBeUndefined();
        expect(cache.getSync('c')).toBe('123456');
        expect(cache.entries).toBe(1);
        expect(cache.bytes).toBe(6);
    });

    it('skips storing a single value larger than maxBytes without evicting existing entries', () => {
        const cache = new BoundedLruCache<string>({ maxBytes: 10 });
        cache.setSync('a', '12345');

        expect(cache.setSync('too-big', '12345678901')).toBe(false);
        expect(cache.getSync('a')).toBe('12345');
        expect(cache.entries).toBe(1);
        expect(cache.bytes).toBe(5);
    });

    it('reclaims bytes on TTL expiration for both defaultTtlMs and KeyValueCache seconds TTL', async () => {
        let now = 1_000;
        const cache = new BoundedLruCache<string>({
            maxBytes: 100,
            defaultTtlMs: 5_000,
            now: () => now,
        });

        cache.setSync('short', 'abcde'); // 5 bytes, expires at 6_000
        await cache.set('apollo', '123456', { ttl: 10 }); // 6 bytes, 10s -> expires at 11_000
        expect(cache.entries).toBe(2);
        expect(cache.bytes).toBe(11);

        now = 6_000;
        expect(cache.getSync('short')).toBeUndefined();
        expect(cache.entries).toBe(1);
        expect(cache.bytes).toBe(6);
        expect(await cache.get('apollo')).toBe('123456');

        now = 11_000;
        expect(await cache.get('apollo')).toBeUndefined();
        expect(cache.entries).toBe(0);
        expect(cache.bytes).toBe(0);
    });
});

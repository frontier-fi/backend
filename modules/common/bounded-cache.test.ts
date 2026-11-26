import { describe, expect, it } from 'vitest';
import { BoundedLruCache } from './bounded-cache';

describe('BoundedLruCache', () => {
    it('evicts oldest entries by maxEntries and tracks entries and bytes accurately', () => {
        const cache = new BoundedLruCache<string>({ maxBytes: 1_000, maxEntries: 2 });

        cache.setSync('a', '1234'); // 1 + 4 = 5 bytes
        cache.setSync('b', '123456'); // 1 + 6 = 7 bytes
        expect(cache.entries).toBe(2);
        expect(cache.bytes).toBe(12);

        // Touch 'a' so 'b' becomes LRU
        expect(cache.getSync('a')).toBe('1234');

        cache.setSync('c', '12'); // 1 + 2 = 3 bytes -> evicts 'b'
        expect(cache.getSync('b')).toBeUndefined();
        expect(cache.getSync('a')).toBe('1234');
        expect(cache.getSync('c')).toBe('12');
        expect(cache.entries).toBe(2);
        expect(cache.bytes).toBe(8);

        // Overwriting updates byte count cleanly
        cache.setSync('a', '12345678'); // 5 -> 9 bytes
        expect(cache.bytes).toBe(12);

        expect(cache.deleteSync('a')).toBe(true);
        expect(cache.deleteSync('a')).toBe(false);
        expect(cache.entries).toBe(1);
        expect(cache.bytes).toBe(3);

        cache.clear();
        expect(cache.entries).toBe(0);
        expect(cache.bytes).toBe(0);
    });

    it('evicts oldest entries when maxBytes is exceeded including key bytes', () => {
        const cache = new BoundedLruCache<string>({ maxBytes: 12 });

        cache.setSync('a', '12345'); // 6 bytes
        cache.setSync('b', '12345'); // 6 bytes
        expect(cache.entries).toBe(2);
        expect(cache.bytes).toBe(12);

        cache.setSync('c', '123456'); // 7 bytes -> evicts 'a' and 'b'
        expect(cache.getSync('a')).toBeUndefined();
        expect(cache.getSync('b')).toBeUndefined();
        expect(cache.getSync('c')).toBe('123456');
        expect(cache.entries).toBe(1);
        expect(cache.bytes).toBe(7);

        // Large key + tiny value also triggers byte-budget eviction
        cache.setSync('large-key-1', 'x'); // 11 + 1 = 12 bytes -> evicts 'c'
        expect(cache.getSync('c')).toBeUndefined();
        expect(cache.entries).toBe(1);
        expect(cache.bytes).toBe(12);
    });

    it('skips storing an entry whose key + value exceeds maxBytes without evicting existing entries', () => {
        const cache = new BoundedLruCache<string>({ maxBytes: 12 });
        cache.setSync('a', '12345'); // 6 bytes

        expect(cache.setSync('too-big', '123456')).toBe(false); // 7 + 6 = 13 bytes
        expect(cache.setSync('123456789012', 'x')).toBe(false); // 12 + 1 = 13 bytes
        expect(cache.getSync('a')).toBe('12345');
        expect(cache.entries).toBe(1);
        expect(cache.bytes).toBe(6);
    });

    it('reclaims bytes on TTL expiration for both defaultTtlMs and KeyValueCache seconds TTL', async () => {
        let now = 1_000;
        const cache = new BoundedLruCache<string>({
            maxBytes: 100,
            defaultTtlMs: 5_000,
            now: () => now,
        });

        cache.setSync('short', 'abcde'); // 5 + 5 = 10 bytes, expires at 6_000
        await cache.set('apollo', '123456', { ttl: 10 }); // 6 + 6 = 12 bytes, 10s -> expires at 11_000
        expect(cache.entries).toBe(2);
        expect(cache.bytes).toBe(22);

        now = 6_000;
        expect(cache.getSync('short')).toBeUndefined();
        expect(cache.entries).toBe(1);
        expect(cache.bytes).toBe(12);
        expect(await cache.get('apollo')).toBe('123456');

        now = 11_000;
        expect(await cache.get('apollo')).toBeUndefined();
        expect(cache.entries).toBe(0);
        expect(cache.bytes).toBe(0);
    });
});

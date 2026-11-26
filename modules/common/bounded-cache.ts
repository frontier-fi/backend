export interface BoundedLruCacheOptions<V> {
    maxBytes: number;
    maxEntries?: number;
    defaultTtlMs?: number;
    sizeOf?: (value: V) => number;
    now?: () => number;
}

interface CacheEntry<V> {
    value: V;
    bytes: number;
    expiresAt?: number;
}

/** Estimates UTF-8 byte footprint of a cached value for memory budgeting. */
export function estimateByteSize(value: unknown): number {
    if (typeof value === 'string') {
        return Buffer.byteLength(value, 'utf8');
    }
    if (typeof value === 'object' && value !== null) {
        try {
            return Buffer.byteLength(JSON.stringify(value), 'utf8');
        } catch {
            return 1024;
        }
    }
    return 16;
}

/**
 * In-memory LRU cache bounded by both entry count and estimated byte size.
 * Structurally implements Apollo Server's KeyValueCache interface.
 */
export class BoundedLruCache<V> {
    readonly maxBytes: number;
    readonly maxEntries: number;
    private readonly defaultTtlMs?: number;
    private readonly sizeOf: (value: V) => number;
    private readonly now: () => number;
    private readonly map = new Map<string, CacheEntry<V>>();
    private totalBytes = 0;

    constructor(options: BoundedLruCacheOptions<V>) {
        this.maxBytes = options.maxBytes;
        this.maxEntries = options.maxEntries ?? Infinity;
        this.defaultTtlMs = options.defaultTtlMs;
        this.sizeOf = options.sizeOf ?? estimateByteSize;
        this.now = options.now ?? Date.now;
    }

    get entries(): number {
        return this.map.size;
    }

    get bytes(): number {
        return this.totalBytes;
    }

    getSync(key: string): V | undefined {
        const entry = this.map.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt !== undefined && this.now() >= entry.expiresAt) {
            this.map.delete(key);
            this.totalBytes -= entry.bytes;
            return undefined;
        }
        // Promote to most-recently-used tail.
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    setSync(key: string, value: V, ttlMs?: number): boolean {
        const entryBytes = Math.max(1, this.sizeOf(value));
        if (entryBytes > this.maxBytes) {
            this.deleteSync(key);
            return false;
        }

        this.deleteSync(key);

        const effectiveTtlMs = ttlMs ?? this.defaultTtlMs;
        const expiresAt = effectiveTtlMs !== undefined && effectiveTtlMs > 0 ? this.now() + effectiveTtlMs : undefined;

        this.map.set(key, { value, bytes: entryBytes, expiresAt });
        this.totalBytes += entryBytes;

        while (this.map.size > this.maxEntries || this.totalBytes > this.maxBytes) {
            const oldestKey = this.map.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.deleteSync(oldestKey);
        }

        return true;
    }

    deleteSync(key: string): boolean {
        const existing = this.map.get(key);
        if (!existing) {
            return false;
        }
        this.map.delete(key);
        this.totalBytes -= existing.bytes;
        return true;
    }

    clear(): void {
        this.map.clear();
        this.totalBytes = 0;
    }

    async get(key: string): Promise<V | undefined> {
        return this.getSync(key);
    }

    async set(key: string, value: V, options?: { ttl?: number | null }): Promise<void> {
        // Apollo KeyValueCache passes ttl in seconds.
        const ttlMs = options?.ttl !== undefined && options.ttl !== null ? options.ttl * 1000 : this.defaultTtlMs;
        this.setSync(key, value, ttlMs);
    }

    async delete(key: string): Promise<boolean> {
        return this.deleteSync(key);
    }
}

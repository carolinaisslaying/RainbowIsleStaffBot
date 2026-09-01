/** Bounded LRU. Used for ring PNGs and hot bitmap documents. */
export class LruCache<K, V> {
    private readonly store = new Map<K, V>();

    constructor(private readonly limit: number) {}

    get(key: K): V | undefined {
        if (!this.store.has(key)) return undefined;
        const value = this.store.get(key) as V;
        this.store.delete(key);
        this.store.set(key, value);
        return value;
    }

    set(key: K, value: V): void {
        if (this.store.has(key)) this.store.delete(key);
        this.store.set(key, value);
        while (this.store.size > this.limit) {
            const oldest = this.store.keys().next().value as K | undefined;
            if (oldest === undefined) break;
            this.store.delete(oldest);
        }
    }

    delete(key: K): void {
        this.store.delete(key);
    }

    clear(): void {
        this.store.clear();
    }

    get size(): number {
        return this.store.size;
    }
}

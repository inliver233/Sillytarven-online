/**
 * Map values with a fixed number of workers while preserving input order.
 * @template T,R
 * @param {T[]} items Values to map
 * @param {number} limit Maximum active mapper calls
 * @param {(item: T, index: number) => Promise<R>|R} mapper Mapper
 * @returns {Promise<R[]>} Ordered mapped values
 */
export async function mapWithConcurrency(items, limit, mapper) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }
    const concurrency = Math.min(items.length, Math.max(1, Math.floor(Number(limit) || 1)));
    const results = new Array(items.length);
    let cursor = 0;

    const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length) {
                return;
            }
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

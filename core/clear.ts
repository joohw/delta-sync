import { DatabaseAdapter, TOMBSTONE_STORE } from "./types";


export const TOMBSTONE_RETENTION = 60 * 24 * 60 * 60 * 1000;



// 清理指定适配器的墓碑记录
export const clearOldTombstones = async (adapter: DatabaseAdapter): Promise<void> => {
    try {
        const cutoffTime = Date.now() - TOMBSTONE_RETENTION;
        const expiredIds: string[] = [];
        let offset: number = 0;
        let hasMore = true;
        let totalScanned = 0;
        console.log(`Starting cleanup of tombstone records before ${new Date(cutoffTime).toISOString()}`);
        while (hasMore) {
            const result = await adapter.listStoreItems(TOMBSTONE_STORE, offset);
            if (!result?.items?.length) {
                break;
            }
            totalScanned += result.items.length;
            // 过滤过期的墓碑记录 - _ver 是时间戳
            const expiredItems = result.items.filter(item => {
                return (item._ver || 0) < cutoffTime;
            });
            expiredIds.push(...expiredItems.map(item => item.id));
            hasMore = result.hasMore || false;
            offset = result.offset || offset + result.items.length;
            if (totalScanned > 100000) { // 最多扫描10万条记录
                console.warn('Reached maximum scan limit, stopping cleanup');
                break;
            }
        }
        if (expiredIds.length > 0) {
            console.log(`Scanned ${totalScanned} records, cleaning ${expiredIds.length} expired tombstone records`);
            const batchSize = 1000;
            for (let i = 0; i < expiredIds.length; i += batchSize) {
                const batch = expiredIds.slice(i, i + batchSize);
                await adapter.deleteBulk(TOMBSTONE_STORE, batch);
                console.log(`Cleaned ${Math.min(i + batchSize, expiredIds.length)}/${expiredIds.length} records`);
            }
        }
    } catch (error) {
        console.error('[clearOldTombstones] Failed to clean old tombstones:', error);
    }
}
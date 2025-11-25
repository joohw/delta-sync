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
        console.log(`开始清理 ${new Date(cutoffTime).toISOString()} 之前的墓碑记录`);
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
                console.warn('达到最大扫描限制，终止清理');
                break;
            }
        }
        if (expiredIds.length > 0) {
            console.log(`扫描了 ${totalScanned} 条记录，清理 ${expiredIds.length} 个过期墓碑记录`);
            const batchSize = 1000;
            for (let i = 0; i < expiredIds.length; i += batchSize) {
                const batch = expiredIds.slice(i, i + batchSize);
                await adapter.deleteBulk(TOMBSTONE_STORE, batch);
                console.log(`已清理 ${Math.min(i + batchSize, expiredIds.length)}/${expiredIds.length} 条记录`);
            }
        } else {
            console.log(`扫描了 ${totalScanned} 条记录，没有找到过期的墓碑记录`);
        }
    } catch (error) {
        console.error('[clearOldTombstones] 清理旧墓碑失败:', error);
    }
}
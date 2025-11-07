import { DatabaseAdapter, DataChange, DataChangeSet } from "./types";
import { TOMBSTONE_STORE, TOMBSTONE_RETENTION } from './types'



export const clearOldTombstones = async (adapter: DatabaseAdapter): Promise<void> => {
    try {
        const cutoffTime = Date.now() - TOMBSTONE_RETENTION;
        const expiredIds: string[] = [];
        let offset: number | undefined = undefined;

        while (true) {
            const result = await adapter.listStoreItems(
                TOMBSTONE_STORE,
                offset,
                undefined,
                cutoffTime
            );
            if (!result?.items?.length) break;
            expiredIds.push(...result.items.filter(item => item?.id).map(item => item.id));
            if (!result.hasMore) break;
            offset = result.offset;
        }

        if (expiredIds.length > 0) {
            await adapter.deleteBulk(TOMBSTONE_STORE, expiredIds);
        }
    } catch (error) {
        console.error('[clearOldTombstones] 清理旧墓碑失败:', error);
    }
}
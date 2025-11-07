import { DatabaseAdapter, DataChangeSet, SyncProgress, DataChange, } from './types';
import { ViewDiff, SyncViewItem } from './SyncView';
import { TOMBSTONE_STORE } from './types'



// 根据视图差异，从源数据库下载数据到目标数据库
export const syncFromDiff = async (
    sourceAdapter: DatabaseAdapter,
    targetAdapter: DatabaseAdapter,
    viewDiff: ViewDiff,
    options: {
        batchSize?: number;
        onProgress?: (progress: SyncProgress) => void;
        onChangesApplied?: (changeSet: DataChangeSet) => void;
        onVersionUpdated?: (version: number) => void;
    } = {}
): Promise<void> => {
    const { batchSize = 100, onProgress, onChangesApplied, onVersionUpdated } = options;
    let updated = 0;
    let deleted = 0;
    let errors = 0;
    // Calculate total items to process
    const totalItems = viewDiff.toDownload.length + viewDiff.toDelete.length;
    let processedItems = 0;
    // Helper function to update progress
    const updateProgress = (increment: number = 1) => {
        processedItems += increment;
        if (onProgress) {
            onProgress({
                processed: processedItems,
                total: totalItems
            });
        }
    };
    // 记录所有处理的数据版本号
    const allVersions: number[] = [];
    for (let i = 0; i < viewDiff.toDownload.length; i += batchSize) {
        const batch = viewDiff.toDownload.slice(i, i + batchSize);
        try {
            const changeSet = await extractChangesFromAdapter(sourceAdapter, batch, []);
            await applyChangesToAdapter(targetAdapter, changeSet, []);
            // 收集版本号
            for (const changes of changeSet.put.values()) {
                for (const change of changes) {
                    allVersions.push(change._ver);
                }
            }
            for (const changes of changeSet.delete.values()) {
                for (const change of changes) {
                    allVersions.push(change._ver);
                }
            }
            onChangesApplied?.(changeSet);
            updated += batch.length;
            updateProgress(batch.length);
        } catch (error) {
            errors++;
            console.error('Data download failed:', error);
            updateProgress(batch.length);
        }
    }
    // Process data deletions
    if (viewDiff.toDelete.length > 0) {
        try {
            const changeSet = await extractChangesFromAdapter(sourceAdapter, viewDiff.toDelete, []);
            await applyChangesToAdapter(targetAdapter, changeSet, []);
            // 收集版本号
            for (const changes of changeSet.delete.values()) {
                for (const change of changes) {
                    allVersions.push(change._ver);
                }
            }
            onChangesApplied?.(changeSet);
            deleted += viewDiff.toDelete.length;
            updateProgress(viewDiff.toDelete.length);
        } catch (error) {
            errors++;
            console.error('Data deletion failed:', error);
            updateProgress(viewDiff.toDelete.length);
        }
    }
    // 计算并回调最大版本号
    if (allVersions.length > 0 && onVersionUpdated) {
        const maxVersion = Math.max(...allVersions);
        onVersionUpdated(maxVersion);
    }
}



// 根据视图读取完整的数据
export const extractChangesFromAdapter = async (
    adapter: DatabaseAdapter,
    items: SyncViewItem[],
    allStores: string[]
): Promise<DataChangeSet> => {
    const deleteMap = new Map<string, DataChange[]>();
    const putMap = new Map<string, DataChange[]>();
    if (!Array.isArray(items)) {
        console.error('[extractChangesFromAdapter] Received invalid items:', items);
        return { delete: deleteMap, put: putMap };
    }
    const regularItems = items.filter(item => allStores.includes(item.store));
    const storeGroups = new Map<string, SyncViewItem[]>();
    for (const item of regularItems) {
        if (!item || typeof item !== 'object' || !item.store || !item.id) {
            console.warn('[extractChangesFromAdapter] Skipping invalid item:', item);
            continue;
        }
        if (!storeGroups.has(item.store)) {
            storeGroups.set(item.store, []);
        }
        storeGroups.get(item.store)!.push(item);
    }
    for (const [store, storeItems] of storeGroups) {
        const deletedItems = storeItems.filter(item => item.deleted);
        const updateItems = storeItems.filter(item => !item.deleted);
        if (deletedItems.length > 0) {
            deleteMap.set(store, deletedItems.map(item => ({
                id: item.id,
                _ver: item._ver
            })));
        }
        if (updateItems.length > 0) {
            try {
                const data = await adapter.readBulk(
                    store,
                    updateItems.map(item => item.id)
                );
                if (!data || !Array.isArray(data)) {
                    console.error(`[extractChangesFromAdapter] readBulk returned invalid data for store ${store}:`, data);
                    continue;
                }
                const changes = data
                    .filter(item => item && typeof item === 'object' && item.id)
                    .map(item => ({
                        id: item.id,
                        data: item,
                        _ver: updateItems.find(i => i.id === item.id)?._ver || Date.now()
                    }));
                if (changes.length > 0) {
                    putMap.set(store, changes);
                }
            } catch (error) {
                console.error(`[extractChangesFromAdapter] Failed to read data from store ${store}:`, error);
                continue;
            }
        }
    }
    return {
        delete: deleteMap,
        put: putMap,
    };
}




// 写入完整的变更到对应的适配器
export const applyChangesToAdapter = async (
    adapter: DatabaseAdapter,
    changeSet: DataChangeSet,
    supportedStores: string[] // 适配器支持的store列表
): Promise<void> => {
    try {
        // 应用数据修改
        for (const [store, changes] of changeSet.put) {
            if (!supportedStores.includes(store)) {
                console.warn(`[applyChangesToAdapter] Skipping unsupported store in put operation: ${store}`);
                continue;
            }
            await adapter.deleteBulk(TOMBSTONE_STORE, changes.map(c => c.id));//防止墓碑中存在数据
            await adapter.putBulk(store, changes.map(c => c.data));
        }
        // 应用删除操作
        for (const [store, changes] of changeSet.delete) {
            if (!supportedStores.includes(store)) {
                console.warn(`[applyChangesToAdapter] Skipping unsupported store in delete operation: ${store}`);
                continue;
            }
            await adapter.deleteBulk(store, changes.map(c => c.id));
            const tombstones = changes.map(change => ({
                id: change.id,
                store: store,
                _ver: change._ver,
                deleted: true
            }));
            await adapter.putBulk(TOMBSTONE_STORE, tombstones);
        }
    } catch (error) {
        console.error('Failed to apply changes:', error);
        throw error;
    }
}
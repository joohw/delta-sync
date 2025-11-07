// 同步检查点
import { DatabaseAdapter } from './types';
import { ViewDiff, SyncViewItem } from './SyncView';


// 单个store的检查点
export interface StoreCheckpoint {
    store: string;
    latestVersion: number; // 该store中所有数据的最新版本号
}


// 整个同步任务的检查点
export type SyncCheckpoint = Map<string, StoreCheckpoint>;



// 读取指定adapter的检查点
export const getCheckpointFromAdapter = async (
    adapter: DatabaseAdapter,
    stores: string[]
): Promise<SyncCheckpoint> => {
    const checkpoint: SyncCheckpoint = new Map();
    for (const store of stores) {
        try {
            const result = await adapter.listStoreItems(store, 0, undefined);
            const latestItem = result.items[0];
            const storeCheckpoint: StoreCheckpoint = {
                store,
                latestVersion: latestItem?._ver || 0,
            };
            checkpoint.set(store, storeCheckpoint);
        } catch (error) {
            console.error(`创建store ${store} 检查点失败:`, error);
            checkpoint.set(store, {
                store,
                latestVersion: 0,
            });
        }
    }
    return checkpoint;
}


export const getLatestVersionFromCheckpoint = (
    checkpoint: SyncCheckpoint
): number => {
    let latestVersion = 0;
    for (const storeCheckpoint of checkpoint.values()) {
        if (storeCheckpoint.latestVersion > latestVersion) {
            latestVersion = storeCheckpoint.latestVersion;
        }
    }
    return latestVersion;
}


export const getDeltaViewDiff = async (
    sourceAdapter: DatabaseAdapter,
    targetAdapter: DatabaseAdapter,
    stores: string[]
): Promise<ViewDiff> => {
    try {
        // 获取目标适配器的检查点（本地最新版本）
        const targetCheckpoint = await getCheckpointFromAdapter(targetAdapter, stores);

        const toDownload: SyncViewItem[] = [];
        const toDelete: SyncViewItem[] = [];

        // 对每个store获取增量变更
        for (const store of stores) {
            const targetVersion = targetCheckpoint.get(store)?.latestVersion || 0;

            // 获取源端（云端）自目标版本以来的所有变更
            let offset: number | undefined = 0;
            while (true) {
                const result = await sourceAdapter.listStoreItems(
                    store,
                    offset,
                    targetVersion // 只获取大于目标版本的数据
                );

                if (!result.items.length) break;

                // 处理增量数据
                for (const item of result.items) {
                    const syncItem: SyncViewItem = {
                        id: item.id,
                        store: store,
                        _ver: item._ver,
                        deleted: false // 需要根据实际情况判断是否是删除
                    };

                    // 这里需要根据你的业务逻辑判断是下载还是删除
                    // 如果是墓碑数据或标记为删除的，添加到 toDelete
                    if (item.deleted) {
                        toDelete.push(syncItem);
                    } else {
                        toDownload.push(syncItem);
                    }
                }

                if (!result.hasMore) break;
                offset = result.offset;
            }
        }

        return { toDownload, toDelete };
    } catch (error) {
        console.error('[getIncrementalDiff] Failed to calculate incremental diff:', error);
        return { toDownload: [], toDelete: [] };
    }
}
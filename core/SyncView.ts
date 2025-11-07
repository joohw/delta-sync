import { DatabaseAdapter } from "./types";
import { TOMBSTONE_STORE } from './types'


// 数据的视图项（用于同步的缩略）
export interface SyncViewItem {
    id: string;
    _ver: number;
    store: string;
    deleted?: boolean;
}


export type ViewDiff = {
    toDownload: SyncViewItem[];      // 需要从远程下载到本地的数据
    toDelete: SyncViewItem[];        // 需要在本地删除的数据
};



// 视图类，作为数据库的缩略，用于快速比对
export class SyncView {

    private stores: Map<string, Map<string, SyncViewItem>>;

    constructor(items: SyncViewItem[] = []) {
        this.stores = new Map();
        for (const item of items) {
            this.addItem(item);
        }
    }

    // 添加单个项目
    private addItem(item: SyncViewItem): void {
        if (!this.stores.has(item.store)) {
            this.stores.set(item.store, new Map());
        }
        this.stores.get(item.store)!.set(item.id, item);
    }

    // 获取单个项目
    get(store: string, id: string): SyncViewItem | undefined {
        const storeMap = this.stores.get(store);
        return storeMap?.get(id);
    }

    // 获取整个store的Map
    getStoreMap(store: string): Map<string, SyncViewItem> | undefined {
        return this.stores.get(store);
    }

    // 获取所有store名称
    getStores(): string[] {
        return Array.from(this.stores.keys());
    }


    // 获取所有项目（扁平化
    getAllItems(): SyncViewItem[] {
        const allItems: SyncViewItem[] = [];
        for (const storeMap of this.stores.values()) {
            allItems.push(...Array.from(storeMap.values()));
        }
        return allItems;
    }

    // 添加或更新项目
    put(item: SyncViewItem): void {
        this.addItem(item);
    }

    // 删除项目
    delete(store: string, id: string): boolean {
        const storeMap = this.stores.get(store);
        if (!storeMap) return false;
        return storeMap.delete(id);
    }


    // 比较两个视图的差异
    static diffViews(local: SyncView, remote: SyncView): ViewDiff {
        const toDownload: SyncViewItem[] = [];
        const toDelete: SyncViewItem[] = [];
        // 获取所有stores的并集，而不仅仅是共有的stores
        const allStores = new Set([
            ...local.getStores(),
            ...remote.getStores()
        ]);
        for (const store of allStores) {
            const localStoreMap = local.getStoreMap(store);
            const remoteStoreMap = remote.getStoreMap(store);
            // 如果远程没有这个store，跳过（本地有的话会由反向diff处理上传）
            if (!remoteStoreMap) {
                continue;
            }
            // 获取这个store中所有id的并集
            const allIds = new Set([
                ...(localStoreMap?.keys() ?? []),
                ...(remoteStoreMap?.keys() ?? [])
            ]);
            for (const id of allIds) {
                const localItem = localStoreMap?.get(id);
                const remoteItem = remoteStoreMap.get(id); // 这里remoteStoreMap肯定存在
                if (!remoteItem) {
                    continue; // 远程不存在，不需要任何操作（上传由反向diff处理）
                }
                if (!localItem) {
                    if (!remoteItem.deleted) {  // 只有未删除的远程项目才需要下载
                        toDownload.push(remoteItem);
                    }
                } else {
                    if (remoteItem._ver > localItem._ver) {
                        if (remoteItem.deleted) {
                            toDelete.push(remoteItem);
                        } else {
                            toDownload.push(remoteItem);
                        }
                    }
                }
            }
        }
        return {
            toDownload,
            toDelete,
        };
    }
    clone(): SyncView {
        return new SyncView(this.getAllItems());
    }
}




export const getSyncViewFromAdapter = async (
    adapter: DatabaseAdapter,
    specificStores?: string[]
): Promise<SyncView> => {
    const storesToProcess = specificStores || [];
    const regularStores = storesToProcess.filter(store => store !== TOMBSTONE_STORE);
    const dataItems: SyncViewItem[] = [];
    // 读取所有常规store的数据
    for (const store of regularStores) {
        const items = await listAllStoreItems(adapter, store);
        dataItems.push(...items.map(item => ({
            id: item.id,
            store: store,
            _ver: item._ver,
            deleted: false
        })));
    }
    // 读取墓碑数据
    const tombstones = await listAllStoreItems(adapter, TOMBSTONE_STORE);
    for (const tombstone of tombstones) {
        const originalStore = tombstone.store;
        if (regularStores.includes(originalStore)) {
            const existingItem = dataItems.find(item =>
                item.store === originalStore && item.id === tombstone.id
            );
            if (existingItem) {
                if (tombstone._ver >= existingItem._ver) {
                    existingItem.deleted = true;
                    existingItem._ver = tombstone._ver;
                }
            } else {
                dataItems.push({
                    id: tombstone.id,
                    store: originalStore,
                    _ver: tombstone._ver,
                    deleted: true
                });
            }
        }
    }
    return new SyncView(dataItems);
}




export const listAllStoreItems = async (
    adapter: DatabaseAdapter,
    storeName: string
): Promise<SyncViewItem[]> => {
    try {
        let allItems: SyncViewItem[] = [];
        let currentOffset: number | undefined = undefined;

        while (true) {
            const result = await adapter.listStoreItems(storeName, currentOffset);
            if (!result || !Array.isArray(result.items)) {
                break;
            }
            allItems = allItems.concat(result.items);
            if (!result.hasMore || result.offset === undefined) {
                break;
            }
            currentOffset = result.offset;
        }
        return allItems;
    } catch (error) {
        console.error(`[getSyncViewFromAdapter] 读取存储${storeName}的所有数据失败:`, error);
        return [];
    }
}



// 比较和目标协调器的差异,计算本地协调器需要做的操作
export const getViewDiff = async (
    sourceAdapter: DatabaseAdapter,
    targetAdapter: DatabaseAdapter,
    stores: string[]
): Promise<ViewDiff> => {
    try {
        const sourceView = await getSyncViewFromAdapter(sourceAdapter, stores);
        const targetView = await getSyncViewFromAdapter(targetAdapter, stores);
        return SyncView.diffViews(targetView, sourceView);
    } catch (error) {
        console.error('[Coordinator] Failed to calculate diff:', error);
        return {
            toDownload: [],
            toDelete: []
        };
    }
}











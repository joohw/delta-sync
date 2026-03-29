import { DatabaseAdapter } from "./types";
import { TOMBSTONE_STORE } from './types'



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


export type SyncCheckPoint = Map<string, number>;



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


    // 比较本地视图相对云端视图的差异，注意参数顺序。
    static diffViews(local: SyncView, remote: SyncView): ViewDiff {
        const toDownload: SyncViewItem[] = [];
        const toDelete: SyncViewItem[] = [];
        const allStores = new Set([
            ...local.getStores(),
            ...remote.getStores()
        ]);
        for (const store of allStores) {
            const localStoreMap = local.getStoreMap(store);
            const remoteStoreMap = remote.getStoreMap(store);
            if (!remoteStoreMap) {
                continue;
            }
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
    specificStores?: string[],
    since?: number
): Promise<SyncView> => {
    const storesToProcess = specificStores || [];
    const regularStores = storesToProcess.filter(store => store !== TOMBSTONE_STORE);
    const dataItems: SyncViewItem[] = [];
    // 读取所有常规store的数据
    for (const store of regularStores) {
        const items = await listAllStoreItems(adapter, store, since);
        dataItems.push(...items.map(item => ({
            id: item.id,
            store: store,
            _ver: item._ver,
        })));
    }
    // 读取墓碑数据加入到store中去
    const tombstones = await listAllStoreItems(adapter, TOMBSTONE_STORE, since);
    for (const tombstone of tombstones) {
        const originalStore = tombstone.store;
        if (regularStores.includes(originalStore)) {
            const existingItem = dataItems.find(item => item.store === originalStore && item.id === tombstone.id);
            if (existingItem) {
                if (tombstone._ver >= existingItem._ver) {
                    existingItem.deleted = true;
                    existingItem._ver = tombstone._ver;
                }
            } else {
                dataItems.push({
                    id: tombstone.id,
                    store: tombstone.store,
                    _ver: tombstone._ver,
                    deleted: true
                });
            }
        }
    }
    return new SyncView(dataItems);
}



// 快速读取store自某个时间点之后的全部syncView
export const listAllStoreItems = async (
    adapter: DatabaseAdapter,
    storeName: string,
    since?: number,
): Promise<SyncViewItem[]> => {
    try {
        let allItems: SyncViewItem[] = [];
        let currentOffset: number | undefined = undefined;
        while (true) {
            const result = await adapter.listStoreItems(storeName, currentOffset, since);
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
        console.error(`[getSyncViewFromAdapter] Failed to read all data from store ${storeName}:`, error);
        return [];
    }
}


// 比较和目标协调器的差异,计算本地协调器需要做的操作
export const getViewDiff = async (
    localAdapter: DatabaseAdapter,   // 本地数据目标  
    remoteAdapter: DatabaseAdapter,  // 远程数据源
    stores: string[],
    since?: number,
): Promise<ViewDiff> => {
    try {
        const localView = await getSyncViewFromAdapter(localAdapter, stores, since);
        const remoteView = await getSyncViewFromAdapter(remoteAdapter, stores, since);
        const result = SyncView.diffViews(localView, remoteView)
        return result;
    } catch (error) {
        console.error('[Coordinator] Failed to calculate diff:', error);
        return {
            toDownload: [],
            toDelete: []
        };
    }
}



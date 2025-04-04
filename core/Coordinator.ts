// core/LocalCoordinator.ts

import {
  ICoordinator,
  DatabaseAdapter,
  SyncView,
  DataChange,
  DataChangeSet,
  SyncViewItem,
  SyncQueryOptions,
  SyncQueryResult,
} from './types';

interface SerializedSyncView {
  id: string;  // 添加必需的 id 字段
  items: Array<SyncViewItem>;
}

export class Coordinator implements ICoordinator {
  syncView: SyncView;
  adapter: DatabaseAdapter;
  private readonly SYNC_VIEW_STORE = 'syncView';
  private readonly SYNC_VIEW_KEY = 'current_view';
  private initialized: boolean = false;


  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
    this.syncView = new SyncView();
  }


  async initSync(): Promise<void> {
    if (this.initialized) return;
    try {
      const result = await this.adapter.readBulk<SerializedSyncView>(
        this.SYNC_VIEW_STORE,
        [this.SYNC_VIEW_KEY]
      );
      if (result.length > 0 && result[0]?.items) {
        this.syncView = SyncView.deserialize(JSON.stringify(result[0].items));
      } else {
        await this.rebuildSyncView();
      }
      this.initialized = true;
    } catch (error) {
      console.error('初始化同步视图失败:', error);
      throw error;
    }
  }


  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initSync();
    }
  }


  async disposeSync(): Promise<void> {
    try {
      await this.persistView();
      this.syncView.clear();
      this.initialized = false;
    } catch (error) {
      console.error('清理同步视图失败:', error);
      throw error;
    }
  }


  async getCurrentView(): Promise<SyncView> {
    await this.ensureInitialized();
    const result = await this.adapter.readBulk<SerializedSyncView>(
      this.SYNC_VIEW_STORE,
      [this.SYNC_VIEW_KEY]
    );
    if (result.length > 0 && result[0]?.items) {
      return SyncView.deserialize(JSON.stringify(result[0].items));
    }
    return new SyncView(); // 返回空视图
  }


  async readBulk<T extends { id: string }>(
    storeName: string,
    ids: string[]
  ): Promise<T[]> {
    try {
      return await this.adapter.readBulk<T>(storeName, ids);
    } catch (error) {
      console.error(`Failed to read bulk data from store ${storeName}:`, error);
      throw error;
    }
  }


  // 通过协调器写入的数据会被追加到syncView用于同步比对
  async putBulk<T extends { id: string }>(
    storeName: string,
    items: T[],
  ): Promise<T[]> {
    await this.ensureInitialized();
    try {
      const newVersion = Date.now();
      const itemsWithVersion = items.map(item => ({
        ...item,
        _ver: newVersion
      }));
      const results = await this.adapter.putBulk(storeName, itemsWithVersion);
      for (const item of results) {
        this.syncView.upsert({
          id: item.id,
          store: storeName,
          _ver: newVersion,
        });
      }
      await this.persistView();
      return results;
    } catch (error) {
      console.error(`Failed to put bulk data to store ${storeName}:`, error);
      throw error;
    }
  }




  async extractChanges<T extends { id: string }>(
    items: SyncViewItem[]
  ): Promise<DataChangeSet> {
    const deleteMap = new Map<string, DataChange[]>();
    const putMap = new Map<string, DataChange[]>();
    const storeGroups = new Map<string, SyncViewItem[]>();
    for (const item of items) {
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
        const data = await this.adapter.readBulk<T>(
          store,
          updateItems.map(item => item.id)
        );
        putMap.set(store, data.map(item => ({
          id: item.id,
          data: item,
          _ver: updateItems.find(i => i.id === item.id)?._ver || Date.now()
        })));
      }
    }
    return {
      delete: deleteMap,
      put: putMap
    };
  }



  async applyChanges<T extends { id: string }>(
    changeSet: DataChangeSet
  ): Promise<void> {
    await this.ensureInitialized();
    try {
      for (const [store, changes] of changeSet.delete) {
        await this.adapter.deleteBulk(store, changes.map(c => c.id));
        changes.forEach(change => {
          this.syncView.upsert({
            id: change.id,
            store,
            _ver: change._ver,
            deleted: true
          });
        });
      }
      // 直接应用更新操作
      for (const [store, changes] of changeSet.put) {
        console.log('changes:', changes.map(c => c.data as T));
        await this.adapter.putBulk(store, changes.map(c => c.data as T));
        changes.forEach(change => {
          this.syncView.upsert({
            id: change.id,
            store,
            _ver: change._ver
          });
        });
      }
      await this.persistView();
    } catch (error) {
      console.error('应用更改失败:', error);
      throw error;
    }
  }





  async deleteBulk(
    storeName: string,
    ids: string[],
    _ver?: number
  ): Promise<void> {
    await this.ensureInitialized();
    try {
      await this.adapter.deleteBulk(storeName, ids);
      const currentVersion = _ver || Date.now();
      for (const id of ids) {
        this.syncView.upsert({
          id,
          store: storeName,
          _ver: currentVersion,
          deleted: true
        });
      }
      await this.persistView();
    } catch (error) {
      console.error('删除数据失败:', error);
      throw error;
    }
  }



  async getAdapter(): Promise<DatabaseAdapter> {
    await this.ensureInitialized();
    return this.adapter;
  }



  private async rebuildSyncView(): Promise<void> {
    console.log('重建同步视图...');
    try {
      this.syncView.clear();
      const stores = await this.adapter.getStores();
      const allStores = stores.filter(store => store !== this.SYNC_VIEW_STORE);
      for (const store of allStores) {
        let offset = 0;
        const limit = 100;
        while (true) {
          const { items, hasMore } = await this.adapter.readStore(
            store,
            limit,
            offset
          );
          for (const item of items) {
            if (item?.id) {
              this.syncView.upsert({
                id: item.id,
                store: store,
                _ver: Date.now(),
              });
            }
          }
          if (!hasMore) break;
          offset += limit;
        }
      }
      await this.persistView();
    } catch (error) {
      console.error('重建同步视图失败:', error);
      throw error;
    }
  }



  async refreshView(): Promise<void> {
    const result = await this.adapter.readBulk<SerializedSyncView>(
      this.SYNC_VIEW_STORE,
      [this.SYNC_VIEW_KEY]
    );
    if (result.length > 0 && result[0]?.items) {
      this.syncView = SyncView.deserialize(JSON.stringify(result[0].items));
    } else {
      this.syncView = new SyncView();
    }
  }



  async query<T extends { id: string }>(
    storeName: string,
    options: SyncQueryOptions = {}
  ): Promise<SyncQueryResult<T>> {
    await this.ensureInitialized();
    const { since = 0, offset = 0, limit = 100 } = options;
    try {
      // 从适配器直接读取数据
      const result = await this.adapter.readStore<T>(
        storeName,
        limit,
        offset
      );
      // 如果需要过滤版本
      if (since > 0) {
        const filteredItems = result.items.filter(item => {
          const viewItem = this.syncView.get(storeName, item.id);
          return viewItem && viewItem._ver > since;
        });
        return {
          items: filteredItems,
          hasMore: result.hasMore
        };
      }
      return result;
    } catch (error) {
      console.error(`Query failed for store ${storeName}:`, error);
      throw error;
    }
  }



  private async persistView(): Promise<void> {
    try {
      const serializedView: SerializedSyncView = {
        id: this.SYNC_VIEW_KEY,
        items: JSON.parse(this.syncView.serialize())
      };
      await this.adapter.putBulk(
        this.SYNC_VIEW_STORE,
        [serializedView]
      );
    } catch (error) {
      console.error('保存同步视图失败:', error);
      throw error;
    }
  }


}

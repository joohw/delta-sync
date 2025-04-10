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


export class Coordinator implements ICoordinator {
  public syncView: SyncView;
  public adapter: DatabaseAdapter;
  private readonly TOMBSTONE_STORE = 'tombStones';
  private readonly TOMBSTONE_RETENTION = 180 * 24 * 60 * 60 * 1000; // 180 days
  private initialized: boolean = false;


  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
    this.syncView = new SyncView();
  }


  async initSync(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.rebuildSyncView();
      await this.clearOldTombstones();
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize sync engine:', error);
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

      this.syncView.clear();
      this.initialized = false;
    } catch (error) {
      console.error('Failed to dispose sync engine:', error);
      throw error;
    }
  }


  async getCurrentView(): Promise<SyncView> {
    await this.ensureInitialized();
    return this.syncView;
  }



  async readAll<T extends { id: string }>(storeName: string): Promise<T[]> {
    try {
      let allItems: T[] = [];
      let offset = 0;
      const limit = 100;
      while (true) {
        const { items, hasMore } = await this.adapter.readStore<T>(
          storeName,
          limit,
          offset
        );
        allItems = allItems.concat(items);
        if (!hasMore) break;
        offset += limit;
      }
      return allItems;
    } catch (error) {
      console.error(`Failed to read all data from store ${storeName}:`, error);
      throw error;
    }
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


  // Data put to the adapter will be tagged with a new version number.
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
        const syncViewItems = changes.map(change => ({
          id: change.id,
          store,
          _ver: change._ver,
          deleted: true
        }));
        await this.addTombstones(syncViewItems);
        this.syncView.upsertBatch(syncViewItems);
      }
      for (const [store, changes] of changeSet.put) {
        await this.adapter.putBulk(store, changes.map(c => c.data as T));
        const syncViewItems = changes.map(change => ({
          id: change.id,
          store,
          _ver: change._ver
        }));
        this.syncView.upsertBatch(syncViewItems);
      }
    } catch (error) {
      console.error('Failed to apply changes:', error);
      throw error;
    }
  }




  async deleteBulk(
    storeName: string,
    ids: string[],
  ): Promise<void> {
    await this.ensureInitialized();
    try {
      await this.adapter.deleteBulk(storeName, ids);
      const currentVersion = Date.now();
      const tombstones = ids.map(id => ({
        id,
        store: storeName,
        _ver: currentVersion,
        deleted: true
      }));
      await this.addTombstones(tombstones);
      this.syncView.upsertBatch(tombstones);
    } catch (error) {
      console.error('Failed to delete data:', error);
      throw error;
    }
  }



  async getAdapter(): Promise<DatabaseAdapter> {
    await this.ensureInitialized();
    return this.adapter;
  }




  async rebuildSyncView(): Promise<void> {
    try {
      this.syncView.clear();
      const stores = (await this.adapter.getStores())
        .filter(store => store !== this.TOMBSTONE_STORE);
      for (const store of stores) {
        const items = await this.readAll<{ id: string; _ver?: number }>(store);
        const itemsToUpsert = items
          .filter(item => item && item.id)
          .map(item => ({
            id: item.id,
            store: store,
            _ver: item._ver || Date.now(),
          }));
        this.syncView.upsertBatch(itemsToUpsert);
      }
      const tombstones = await this.readAll<SyncViewItem>(this.TOMBSTONE_STORE);
      this.syncView.upsertBatch(tombstones);
    } catch (error) {
      console.error('Failed to rebuild sync view:', error);
      throw error;
    }
  }



  async query<T extends { id: string }>(
    storeName: string,
    options: SyncQueryOptions = {}
  ): Promise<SyncQueryResult<T>> {
    await this.ensureInitialized();
    const { since = 0, offset = 0, limit = 100 } = options;
    try {
      const result = await this.adapter.readStore<T>(
        storeName,
        limit,
        offset
      );
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



  private async clearOldTombstones(): Promise<void> {
    try {
      const { items } = await this.adapter.readStore<SyncViewItem>(this.TOMBSTONE_STORE);
      const now = Date.now();
      const expiredTombstones = items.filter(item =>
        item._ver < (now - this.TOMBSTONE_RETENTION)
      );
      if (expiredTombstones.length > 0) {
        const expiredIds = expiredTombstones.map(item => item.id);
        await this.adapter.deleteBulk(this.TOMBSTONE_STORE, expiredIds);
        expiredTombstones.forEach(item => {
          this.syncView.delete(item.store, item.id);
        });
      }
    } catch (error) {
      console.error('Failed to clear old tombstones:', error);
    }
  }


  private async addTombstones(items: SyncViewItem[]): Promise<void> {
    await this.adapter.putBulk(this.TOMBSTONE_STORE, items);
  }



}

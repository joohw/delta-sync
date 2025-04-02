// core/LocalCoordinator.ts

import {
  ICoordinator,
  DatabaseAdapter,
  SyncView,
  SyncViewItem,
  SyncQueryOptions,
  SyncQueryResult,
} from './types';

interface SerializedSyncView {
  id: string;  // 添加必需的 id 字段
  items: Array<SyncViewItem>;
}

export class Coordinator implements ICoordinator {
  private syncView: SyncView;
  private adapter: DatabaseAdapter;
  private readonly SYNC_VIEW_STORE = 'local_sync_view';
  private readonly SYNC_VIEW_KEY = 'current_view';
  private initialized: boolean = false;
  private dataChangeCallback?: () => void;

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

  onDataChanged(callback: () => void): void {
    this.dataChangeCallback = callback;
  }

  private notifyDataChanged(): void {
    this.dataChangeCallback?.();
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
    return this.syncView;
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

  async putBulk<T extends { id: string }>(
    storeName: string,
    items: T[],
    silent: boolean = false
  ): Promise<T[]> {
    await this.ensureInitialized();
    try {
      const results = await this.adapter.putBulk(storeName, items);
      // 更新同步视图
      for (const item of results) {
        this.syncView.upsert({
          id: item.id,
          store: storeName,
          version: Date.now(),
        });
      }
      if (!silent) {
        this.notifyDataChanged();
      }
      await this.persistView();
      return results;
    } catch (error) {
      console.error(`Failed to put bulk data to store ${storeName}:`, error);
      throw error;
    }
  }

  async deleteBulk(storeName: string, ids: string[]): Promise<void> {
    await this.ensureInitialized();
    try {
      await this.adapter.deleteBulk(storeName, ids);
      const version = Date.now();
      // 更新同步视图，标记删除
      for (const id of ids) {
        this.syncView.upsert({
          id,
          store: storeName,
          version,
          deleted: true
        });
      }
      this.notifyDataChanged();
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
    try {
      this.syncView.clear();
      const stores = await this.adapter.getStores();
      const allStores = [
        ...stores,
        this.SYNC_VIEW_STORE,
        SyncView.ATTACHMENT_STORE
      ];

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
                version: Date.now(), // 使用当前时间作为版本号
                isAttachment: store === SyncView.ATTACHMENT_STORE
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

  async applyChanges<T extends { id: string }>(
    storeName: string,
    changes: T[]
  ): Promise<void> {
    if (changes.length === 0) return;
    await this.putBulk(storeName, changes, true);
  }


  async query<T extends { id: string }>(
    storeName: string,
    options: SyncQueryOptions = {}
  ): Promise<SyncQueryResult<T>> {
    await this.ensureInitialized();
    const { since = 0, offset = 0, limit = 100 } = options;

    try {
      // 1. 获取同步视图中的项目
      let items = this.syncView.getByStore(storeName);

      // 2. 根据since筛选
      if (since > 0) {
        items = items.filter(item => item.version > since);
      }

      // 3. 应用分页
      const paginatedItems = items.slice(offset, offset + limit);

      // 4. 读取完整数据
      const results = await this.readBulk<T>(
        storeName,
        paginatedItems.map(item => item.id)
      );

      return {
        items: results,
        hasMore: items.length > offset + limit
      };
    } catch (error) {
      console.error(`查询数据失败 ${storeName}:`, error);
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

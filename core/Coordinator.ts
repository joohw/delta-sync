// core/LocalCoordinator.ts

import {
  ICoordinator,
  DatabaseAdapter,
  DeltaModel,
  SyncView,
  FileItem,
  Attachment,
  DataChange,
  DataItem,
  SyncQueryOptions,
  SyncQueryResult,
} from './types';


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
      const result = await this.adapter.readBulk(
        this.SYNC_VIEW_STORE,
        [this.SYNC_VIEW_KEY]
      );
      if (result.length > 0 && result[0].data) {
        this.syncView = SyncView.deserialize(result[0].data);
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



  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initSync();
    }
  }


  async getCurrentView(): Promise<SyncView> {
    await this.ensureInitialized();
    return this.syncView;
  }


  async readBulk(storeName: string, ids: string[]): Promise<any[]> {
    try {
      return await this.adapter.readBulk(storeName, ids);
    } catch (error) {
      console.error(`Failed to read bulk data from store ${storeName}:`, error);
      throw error;
    }
  }

  async downloadFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>> {
    await this.ensureInitialized();
    return this.adapter.readFiles(fileIds);
  }


  async putBulk<T>(storeName: string, items: T[], silent: boolean = false  // 默认会触发通知
  ): Promise<T[]> {
    try {
      const dataItems: DataItem[] = items.map(item => ({
        id: (item as any).id,
        data: item
      }));
      const results = await this.adapter.putBulk(storeName, dataItems);
      // 更新同步视图
      for (const item of results) {
        if ('id' in item && 'version' in item) {
          this.syncView.upsert({
            id: item.id,
            store: storeName,
            version: item.version,
            deleted: false
          });
        }
      }
      if (!silent) { this.notifyDataChanged(); }
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


  async uploadFiles(files: FileItem[]): Promise<Attachment[]> {
    await this.ensureInitialized();
    const attachments = await this.adapter.saveFiles(files);
    for (const attachment of attachments) {
      this.syncView.upsertAttachment(attachment);
    }
    await this.persistView();
    this.notifyDataChanged();
    return attachments;
  }


  async deleteFiles(fileIds: string[]): Promise<void> {
    await this.ensureInitialized();
    const result = await this.adapter.deleteFiles(fileIds);
    for (const deletedId of result.deleted) {
      this.syncView.delete(SyncView['ATTACHMENT_STORE'], deletedId);
    }
    this.notifyDataChanged();
    await this.persistView();
  }


  async getAdapter(): Promise<DatabaseAdapter> {
    await this.ensureInitialized();
    return this.adapter;
  }


  // 重建同步视图
  private async rebuildSyncView(): Promise<void> {
    try {
      this.syncView.clear();
      const stores = this.syncView.getStores();
      for (const store of stores) {
        let offset = 0;
        const limit = 100;
        while (true) {
          const { items, hasMore } = await this.adapter.readStore<DeltaModel>(
            store,
            limit,
            offset
          );
          for (const item of items) {
            if (item.version) {
              this.syncView.upsert({
                id: item.id,
                store: item.store,
                version: item.version,
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


  // 应用数据变更同时不触发回调
  async applyChanges(changes: DataChange[]): Promise<void> {
    const version = Date.now();
    const items = changes.map(change => ({
      id: change.id,
      store: change.store,
      data: change.data,
      version,
      deleted: change.operation === 'delete'
    }));
    await this.putBulk(changes[0].store, items, true);
  }




  async querySync(
    storeName: string,
    options: SyncQueryOptions = {}
  ): Promise<SyncQueryResult<DeltaModel>> {
    await this.ensureInitialized();
    const {
      since = 0,
      offset = 0,
      limit = 100,
      order = 'desc'  // 默认降序
    } = options;
    try {
      // 修正过滤逻辑
      const items = this.syncView.getByStore(storeName)
        .filter(item =>
          order === 'desc'
            ? item.version < since    // 降序：获取更早的
            : item.version > since    // 升序：获取更新的
        )
        .sort((a, b) => {
          const comparison = a.version - b.version;
          return order === 'asc' ? comparison : -comparison;
        })
        .slice(offset, offset + limit);
      const deltaModels = await this.readBulk(
        storeName,
        items.map(item => item.id)
      );
      return {
        items: deltaModels,
        hasMore: items.length === limit
      };
    } catch (error) {
      console.error(`Sync query failed for store ${storeName}:`, error);
      throw error;
    }
  }


  // 持久化视图
  private async persistView(): Promise<void> {
    try {
      const dataItem: DataItem = {
        id: this.SYNC_VIEW_KEY,
        data: this.syncView.serialize()
      };
      await this.adapter.putBulk(this.SYNC_VIEW_STORE, [dataItem]);
    } catch (error) {
      console.error('保存同步视图失败:', error);
      throw error;
    }
  }




}

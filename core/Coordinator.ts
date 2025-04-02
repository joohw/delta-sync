// core/LocalCoordinator.ts

import {
  ICoordinator,
  DatabaseAdapter,
  SyncView,
  FileItem,
  Attachment,
  DataChange,
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
      if (result.length > 0 && result[0]?.items) {  // 检查 items 是否存在
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



  async putBulk<T extends { id: string }>(
    storeName: string,
    items: T[],
    silent: boolean = false
  ): Promise<T[]> {
    await this.ensureInitialized();
    try {
      const results = await this.adapter.putBulk(storeName, items);
      for (const item of results) {
        this.syncView.upsert({
          id: item.id,
          store: storeName,
          version: Date.now(), // 或者使用 item.updatedAt 如果存在的话
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
          const { items, hasMore } = await this.adapter.readStore<DataChange>(
            store,
            limit,
            offset
          );
          for (const item of items) {
            if (item?.id && item?.version) {
              this.syncView.upsert({
                id: item.id,
                store: store,
                version: item.version,
                deleted: item.operation === 'delete',
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



  // 应用数据变更同时不触发回调
  async applyChanges(changes: DataChange[]): Promise<void> {
    await this.putBulk(changes[0].store, changes, true);
  }



  async querySync(
    storeName: string,
    options: SyncQueryOptions = {}
  ): Promise<SyncQueryResult<DataChange>> {
    await this.ensureInitialized();
    const {
      since = 0,
      offset = 0,
      limit = 100,
    } = options;
    try {
      let items = this.syncView.getByStore(storeName);
      // 2. 根据since筛选
      if (since > 0) {
        items = items.filter(item => item.version > since);
      }
      // 3. 应用分页
      const paginatedItems = items.slice(offset, offset + limit);
      // 4. 读取完整数据
      const deltaModels = await this.readBulk(
        storeName,
        paginatedItems.map(item => item.id)
      );
      // 5. 映射结果，保持与分页项的顺序一致
      const resultModels = paginatedItems
        .map(item => deltaModels.find(model => model.id === item.id))
        .filter((model): model is DataChange => model !== undefined);
      return {
        items: resultModels,
        hasMore: items.length > offset + limit
      };
    } catch (error) {
      console.error(`查询同步数据失败 ${storeName}:`, error);
      throw error;
    }
  }



  // 持久化视图
  private async persistView(): Promise<void> {
    try {
      // 创建符合类型约束的对象
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

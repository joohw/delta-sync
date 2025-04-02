// core/LocalCoordinator.ts

import {
  ILocalCoordinator,
  DatabaseAdapter,
  DeltaModel,
  SyncView,
  FileItem,
  Attachment,
  DataItem
} from './types';


export class LocalCoordinator implements ILocalCoordinator {
  private syncView: SyncView;
  private adapter: DatabaseAdapter;
  private readonly SYNC_VIEW_STORE = 'local_sync_view';
  private readonly SYNC_VIEW_KEY = 'current_view';
  private initialized: boolean = false;


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



  async putBulk<T>(storeName: string, items: T[]): Promise<T[]> {
    try {
      // 准备数据项
      const dataItems: DataItem[] = items.map(item => ({
        id: (item as any).id,
        data: item
      }));
      // 保存数据
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
      await this.persistView();
    } catch (error) {
      console.error('删除数据失败:', error);
      throw error;
    }
  }


  async downloadFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>> {
    await this.ensureInitialized();
    return this.adapter.readFiles(fileIds);
  }


  async uploadFiles(files: FileItem[]): Promise<Attachment[]> {
    await this.ensureInitialized();
    const attachments = await this.adapter.saveFiles(files);
    for (const attachment of attachments) {
      this.syncView.upsertAttachment(attachment);
    }
    await this.persistView();
    return attachments;
  }


  async deleteFiles(fileIds: string[]): Promise<void> {
    await this.ensureInitialized();
    const result = await this.adapter.deleteFiles(fileIds);
    for (const deletedId of result.deleted) {
      this.syncView.delete(SyncView['ATTACHMENT_STORE'], deletedId);
    }
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
                deleted: item.deleted
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

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


  async putBulk(
    storeName: string,
    items: DeltaModel[],
    silent: boolean = false
  ): Promise<DeltaModel[]> {
    await this.ensureInitialized();
    try {
      // 确保所有项都有正确的store和version
      const normalizedItems = items.map(item => ({
        ...item,
        store: storeName,  // 确保store正确
        version: item.version || Date.now(),  // 如果没有version则使用当前时间戳
        deleted: item.deleted || false  // 确保deleted字段存在
      }));

      // 转换为DataItem格式供适配器使用
      const dataItems: DataItem[] = normalizedItems.map(item => ({
        id: item.id,
        data: item  // 存储完整的DeltaModel
      }));

      // 写入数据
      const results = await this.adapter.putBulk(storeName, dataItems);
      // 将结果转换回DeltaModel格式
      const deltaResults = results.map(result => {
        // 确保返回的数据符合DeltaModel接口
        const deltaModel: DeltaModel = {
          id: result.id,
          store: storeName,
          data: result.data?.data || result.data,
          version: result.version || result.data?.version,
          deleted: result.deleted || false
        };
        return deltaModel;
      });
      // 更新同步视图
      for (const item of deltaResults) {
        this.syncView.upsert({
          id: item.id,
          store: storeName,
          version: item.version,
          deleted: item.deleted,
          revisionCount: (item as any).revisionCount
        });
      }
      // 如果不是静默操作，触发变更通知
      if (!silent) {
        this.notifyDataChanged();
      }
      // 持久化同步视图
      await this.persistView();
      return deltaResults;
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
          const { items, hasMore } = await this.adapter.readStore<DeltaModel>(
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
                deleted: item.deleted || false,
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
    } = options;
    try {
      // 1. 获取store的所有items
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
        .filter((model): model is DeltaModel => model !== undefined);
      // 6. 返回结果
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

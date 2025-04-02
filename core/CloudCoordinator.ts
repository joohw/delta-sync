// core/CloudCoordinator.ts

import {
    ICloudCoordinator,
    DatabaseAdapter,
    SyncView,
    FileItem,
    Attachment,
    DataItem,
    DataChange
} from './types';


export class CloudCoordinator implements ICloudCoordinator {
    private syncView: SyncView;
    private adapter: DatabaseAdapter;
    private initialized: boolean = false;
    private readonly DELTA_STORE = 'cloud_deltas';
    private readonly SYNC_VIEW_STORE = 'cloud_sync_view';
    private readonly SYNC_VIEW_KEY = 'current_view';


    constructor(adapter: DatabaseAdapter) {
        this.adapter = adapter;
        this.syncView = new SyncView();
    }


    private async ensureInitialized(): Promise<void> {
        if (this.initialized) return;
        try {
            const result = await this.adapter.readBulk(
                this.SYNC_VIEW_STORE,
                [this.SYNC_VIEW_KEY]
            );
            if (result.length > 0 && result[0].data) {
                this.syncView = SyncView.deserialize(result[0].data);
            } else {
                // 如果没有存储的视图，重建
                await this.rebuildSyncView();
            }
            this.initialized = true;
        } catch (error) {
            console.error('初始化云端同步视图失败:', error);
            throw error;
        }
    }


    // 实现接口方法
    async getCurrentView(): Promise<SyncView> {
        await this.ensureInitialized();
        return this.syncView;
    }


    async readBulk(storeName: string, ids: string[]): Promise<any[]> {
        await this.ensureInitialized();
        const cloudKeys = ids.map(id => this.getCloudKey(storeName, id));
        const results = await this.adapter.readBulk(this.DELTA_STORE, cloudKeys);
        return results.map(item => item?.data || null);
    }


    async applyChanges(changes: DataChange[]): Promise<void> {
        await this.ensureInitialized();
        try {
            const version = Date.now();
            const items: DataItem[] = changes.map(change => ({
                id: this.getCloudKey(change.store, change.id),
                data: change.operation === 'delete' ? null : change.data
            }));
            // 批量保存到单一存储
            await this.adapter.putBulk(this.DELTA_STORE, items);
            // 更新视图
            for (const change of changes) {
                this.syncView.upsert({
                    id: change.id,
                    store: change.store,
                    version: version,
                    deleted: change.operation === 'delete'
                });
            }
            // 持久化视图
            await this.persistView();
        } catch (error) {
            console.error('应用云端变更失败:', error);
            throw error;
        }
    }


    async downloadFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>> {
        return this.adapter.readFiles(fileIds);
    }


    async uploadFiles(files: FileItem[]): Promise<Attachment[]> {
        const attachments = await this.adapter.saveFiles(files);
        // 更新视图
        for (const attachment of attachments) {
            this.syncView.upsertAttachment(attachment);
        }
        await this.persistView();
        return attachments;
    }


    async deleteFiles(fileIds: string[]): Promise<void> {
        const result = await this.adapter.deleteFiles(fileIds);
        // 更新视图
        for (const deletedId of result.deleted) {
            this.syncView.delete(SyncView['ATTACHMENT_STORE'], deletedId);
        }
        await this.persistView();
    }



    private async persistView(): Promise<void> {
        try {
            await this.adapter.putBulk(this.SYNC_VIEW_STORE, [{
                id: this.SYNC_VIEW_KEY,
                data: this.syncView.serialize()
            }]);
        } catch (error) {
            console.error('保存云端同步视图失败:', error);
            throw error;
        }
    }




    private async rebuildSyncView(): Promise<void> {
        try {
            this.syncView.clear();
            let offset = 0;
            const limit = 100;
            while (true) {
                const { items, hasMore } = await this.adapter.readStore<DataItem>(
                    this.DELTA_STORE,
                    limit,
                    offset
                );
                for (const item of items) {
                    const [store, originalId] = this.getOrigianlKey(item.id);
                    if (!store || !originalId) continue;
                    this.syncView.upsert({
                        id: originalId,
                        store: store,
                        version: Date.now(), // 或者从数据中获取版本号
                        deleted: item.data === null
                    });
                }
                if (!hasMore) break;
                offset += limit;
            }
            await this.persistView();
        } catch (error) {
            console.error('重建云端同步视图失败:', error);
            throw error;
        }
    }


    // 生成云端存储的复合键
    private getCloudKey(store: string, id: string): string {
        return `${store}:${id}`;
    }

    private getOrigianlKey(cloudKey: string): [string, string] {
        return cloudKey.split(':') as [string, string];
    }

}

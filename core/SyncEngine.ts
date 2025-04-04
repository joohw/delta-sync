// core/SyncEngine.ts

import {
    ISyncEngine,
    DatabaseAdapter,
    SyncOptions,
    SyncView,
    SyncStatus,
    SyncResult,
    SyncQueryOptions,
    SyncQueryResult,
} from './types';

import { Coordinator } from './Coordinator'


export class SyncEngine implements ISyncEngine {

    private localCoordinator: Coordinator;
    private cloudCoordinator?: Coordinator;
    private options: SyncOptions;
    private syncStatus: SyncStatus = SyncStatus.IDLE;
    private isInitialized: boolean = false;
    private pullTimer?: ReturnType<typeof setInterval>;    // 定时拉取定时器
    private pushDebounceTimer?: ReturnType<typeof setTimeout>;  // 推送防抖定时器


    constructor(
        localAdapter: DatabaseAdapter,
        options: SyncOptions = {}
    ) {
        this.localCoordinator = new Coordinator(localAdapter);
        this.options = this.mergeDefaultOptions(options);
    }


    private mergeDefaultOptions(options: SyncOptions): SyncOptions {
        return {
            autoSync: {
                enabled: false,
                pullInterval: 60000,    // 默认30秒拉取一次
                pushDebounce: 10000,    // 默认10秒防抖
                retryDelay: 1000,       // 默认1秒重试延迟
                ...options.autoSync
            },
            maxRetries: 3,
            timeout: 30000,
            batchSize: 100,
            maxFileSize: 10 * 1024 * 1024, // 10MB
            fileChunkSize: 1024 * 1024, // 1MB
            ...options
        };
    }


    async initialize(): Promise<void> {
        if (this.isInitialized) return;
        try {
            if (this.options.autoSync?.enabled) {
                this.enableAutoSync(this.options.autoSync.pullInterval);
            }
            this.isInitialized = true;
        } catch (error) {
            console.error('初始化同步引擎失败:', error);
            throw error;
        }
    }


    private async ensureInitialized(): Promise<void> {
        if (!this.isInitialized) {
            await this.initialize();
        }
    }


    async setCloudAdapter(cloudAdapter: DatabaseAdapter): Promise<void> {
        console.log('[SyncEngine] Setting cloud adapter:', cloudAdapter);
        this.updateStatus(SyncStatus.IDLE)
        this.cloudCoordinator = new Coordinator(cloudAdapter);
    }


    // 数据操作方法
    async save<T extends { id: string }>(
        storeName: string,
        data: T | T[]
    ): Promise<T[]> {
        await this.ensureInitialized();
        try {
            const items = Array.isArray(data) ? data : [data];
            const savedItems = await this.localCoordinator.putBulk(storeName, items);
            this.handleDataChange();
            return savedItems;
        } catch (error) {
            console.error('Save operation failed:', error);
            throw error;
        }
    }


    async delete(storeName: string, ids: string | string[]): Promise<void> {
        await this.ensureInitialized();
        try {
            const idsToDelete = Array.isArray(ids) ? ids : [ids];
            await this.localCoordinator.deleteBulk(storeName, idsToDelete);
            this.handleDataChange();
        } catch (error) {
            console.error('Delete operation failed:', error);
            throw error;
        }
    }


    // 同步操作方法
    async sync(): Promise<SyncResult> {
        console.log('[SyncEngine] Syncing...');
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        try {
            const pullResult = await this.pull();
            const pushResult = await this.push();
            this.updateStatus(SyncStatus.IDLE);
            console.log('[SyncEngine] Sync completed');
            return {
                success: pullResult.success && pushResult.success,
                error: pullResult.success ? pushResult.error : pullResult.error,
                syncedAt: Date.now(),
                stats: {
                    uploaded: pushResult.stats?.uploaded || 0,
                    downloaded: pullResult.stats?.downloaded || 0,
                    errors: (pullResult.stats?.errors || 0) + (pushResult.stats?.errors || 0)
                }
            };
        } catch (error) {
            this.updateStatus(SyncStatus.ERROR);
            console.error('Sync failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
    }


    async pull(): Promise<SyncResult> {
        console.log('[SyncEngine] Pulling...');
        if (!this.cloudCoordinator) {
            console.log('[SyncEngine] Pull skipped, cloud adapter not set');
            this.updateStatus(SyncStatus.OFFLINE);
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        try {
            this.updateStatus(SyncStatus.DOWNLOADING);
            await this.cloudCoordinator.refreshView();
            const localView = await this.localCoordinator.getCurrentView();
            const cloudView = await this.cloudCoordinator.getCurrentView();
            console.log('[SyncEngine] Comparing views for pull');
            const { toDownload } = SyncView.diffViews(localView, cloudView);
            if (toDownload.length === 0) {
                this.updateStatus(SyncStatus.IDLE);
                return {
                    success: true,
                    syncedAt: Date.now(),
                    stats: { uploaded: 0, downloaded: 0, errors: 0 }
                };
            }
            console.log('[SyncEngine] Extracting changes for pull:', toDownload.length, 'items');
            const changeSet = await this.cloudCoordinator.extractChanges(toDownload);
            let downloadedCount = 0;
            for (const itemChanges of changeSet.put.values()) {
                downloadedCount += itemChanges.length;
            }
            for (const itemChanges of changeSet.delete.values()) {
                downloadedCount += itemChanges.length;
            }
            // 更新版本号
            const latestVersion = Math.max(...toDownload.map(item => item._ver));
            if (latestVersion && this.options.onVersionUpdate) {
                this.options.onVersionUpdate(latestVersion);
            }
            // 应用更改到本地
            console.log('[SyncEngine] Applying changes to local storage');
            await this.localCoordinator.applyChanges(changeSet);
            // 触发拉取回调
            this.options.onChangePulled?.(changeSet);
            this.updateStatus(SyncStatus.IDLE);
            console.log('[SyncEngine] Pull completed successfully');
            return {
                success: true,
                syncedAt: Date.now(),
                stats: {
                    uploaded: 0,
                    downloaded: downloadedCount,
                    errors: 0
                }
            };
        } catch (error) {
            this.updateStatus(SyncStatus.ERROR);
            console.error('[SyncEngine] Pull failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Pull failed',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
    }
    

    async push(): Promise<SyncResult> {
        console.log('[SyncEngine] Pushing...');
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            console.log('[SyncEngine] Push skipped, cloud adapter not set');
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        try {
            this.updateStatus(SyncStatus.UPLOADING);
            await this.cloudCoordinator.refreshView();
            const localView = await this.localCoordinator.getCurrentView();
            const cloudView = await this.cloudCoordinator.getCurrentView();
            console.log('[SyncEngine] Comparing views for push');
            
            const { toUpload } = SyncView.diffViews(localView, cloudView);
            if (toUpload.length === 0) {
                this.updateStatus(SyncStatus.IDLE);
                return {
                    success: true,
                    syncedAt: Date.now(),
                    stats: { uploaded: 0, downloaded: 0, errors: 0 }
                };
            }
    
            console.log('[SyncEngine] Extracting changes for push:', toUpload.length, 'items');
            const changeSet = await this.localCoordinator.extractChanges(toUpload);
            
            let uploadedCount = 0;
            for (const itemChanges of changeSet.put.values()) {
                uploadedCount += itemChanges.length;
            }
            for (const itemChanges of changeSet.delete.values()) {
                uploadedCount += itemChanges.length;
            }
    
            // 执行云端更新
            console.log('[SyncEngine] Applying changes to cloud');
            await this.cloudCoordinator.applyChanges(changeSet);
    
            // 更新版本号
            const latestVersion = Math.max(...toUpload.map(item => item._ver));
            if (latestVersion && this.options.onVersionUpdate) {
                this.options.onVersionUpdate(latestVersion);
            }
    
            // 触发推送回调
            this.options.onChangePushed?.(changeSet);
            
            this.updateStatus(SyncStatus.IDLE);
            console.log('[SyncEngine] Push completed successfully');
            
            return {
                success: true,
                syncedAt: Date.now(),
                stats: {
                    uploaded: uploadedCount,
                    downloaded: 0,
                    errors: 0
                }
            };
        } catch (error) {
            this.updateStatus(SyncStatus.ERROR);
            console.error('[SyncEngine] Push failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Push failed',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
    }
    



    async query<T extends { id: string }>(
        storeName: string,
        options?: SyncQueryOptions
    ): Promise<SyncQueryResult<T>> {
        await this.ensureInitialized();
        try {
            const result = await this.localCoordinator.query<T>(storeName, options);
            return result;
        } catch (error) {
            console.error(`Query failed for store ${storeName}:`, error);
            throw error;
        }
    }



    // 自动同步控制
    enableAutoSync(pullInterval?: number): void {
        if (this.pullTimer) {
            clearInterval(this.pullTimer);
        }
        const currentAutoSync = this.options.autoSync || {};
        this.options.autoSync = {
            ...currentAutoSync,
            enabled: true,
            pullInterval: pullInterval || currentAutoSync.pullInterval || 30000000
        };
        console.log('[SyncEngine] Enabling auto sync with pull interval:',
            this.options.autoSync.pullInterval);
        this.pullTimer = setInterval(() => {
            this.executePullTask();
        }, this.options.autoSync.pullInterval);
    }


    disableAutoSync(): void {
        if (this.pullTimer) {
            clearInterval(this.pullTimer);
            this.pullTimer = undefined;
        }
        if (this.pushDebounceTimer) {
            clearTimeout(this.pushDebounceTimer);
            this.pushDebounceTimer = undefined;
        }
        const currentAutoSync = this.options.autoSync || {};
        this.options.autoSync = {
            ...currentAutoSync,
            enabled: false
        };
    }


    // 拆分为独立的拉取任务
    private async executePullTask(): Promise<void> {
        if (this.syncStatus !== SyncStatus.IDLE) {
            return;
        }
        try {
            await this.pull();
        } catch (error) {
            console.error('[SyncEngine] Pull task failed:', error);
        }
    }


    // 本地数据变更触发推送
    private handleDataChange(): void {
        console.log('[SyncEngine] Data change detected at:', new Date().toISOString());
        if (!this.options.autoSync?.enabled) {
            console.log('[SyncEngine] Auto sync disabled, skipping push');
            return;
        }
        if (!this.cloudCoordinator) {
            console.log('[SyncEngine] No cloud coordinator, skipping push');
            return;
        }
        if (this.pushDebounceTimer) {
            clearTimeout(this.pushDebounceTimer);
        }
        console.log('[SyncEngine] Scheduling push task');
        this.pushDebounceTimer = setTimeout(async () => {
            try {
                if (this.canTriggerSync()) {
                    console.log('[SyncEngine] Executing scheduled push');
                    await this.push();
                } else {
                    console.log('[SyncEngine] Push skipped due to conditions not met');
                }
            } catch (error) {
                console.error('[SyncEngine] Scheduled push failed:', error);
            }
        }, this.options.autoSync?.pushDebounce || 10000);
    }


    // 添加同步条件检查方法
    private canTriggerSync(): boolean {
        const isAutoSyncEnabled = this.options.autoSync?.enabled === true;
        const canSync = Boolean(
            isAutoSyncEnabled &&
            this.cloudCoordinator !== undefined &&
            ![SyncStatus.ERROR, SyncStatus.UPLOADING, SyncStatus.DOWNLOADING].includes(this.syncStatus)
        );
        return canSync;
    }


    // 配置更新
    updateSyncOptions(options: Partial<SyncOptions>): SyncOptions {
        // 更新选项
        this.options = this.mergeDefaultOptions({
            ...this.options,
            ...options
        });
        // 处理自动同步设置
        if (options.autoSync) {
            if (options.autoSync.enabled) {
                this.enableAutoSync(options.autoSync.pullInterval);
            } else {
                this.disableAutoSync();
            }
        }
        return this.options;
    }


    async clearCloudStores(stores: string | string[]): Promise<void> {
        if (!this.cloudCoordinator) {
            throw new Error('Cloud adapter not set');
        }
        try {
            // 更新状态为操作中
            this.updateStatus(SyncStatus.OPERATING);
            const cloudAdapter = await this.cloudCoordinator.getAdapter();
            const availableStores = await cloudAdapter.getStores();
            const storesToClear = Array.isArray(stores) ? stores : [stores];
            const invalidStores = storesToClear.filter(store => !availableStores.includes(store));
            if (invalidStores.length > 0) {
                throw new Error(`Invalid stores: ${invalidStores.join(', ')}`);
            }
            const clearPromises = storesToClear.map(async (store) => {
                try {
                    const result = await cloudAdapter.clearStore(store);
                    if (!result) {
                        console.warn(`Failed to clear store: ${store}`);
                    }
                    return { store, success: result };
                } catch (error) {
                    console.error(`Error clearing store ${store}:`, error);
                    return { store, success: false };
                }
            });
            const results = await Promise.all(clearPromises);
            const failures = results.filter(r => !r.success);
            if (failures.length > 0) {
                throw new Error(`Failed to clear stores: ${failures.map(f => f.store).join(', ')}`);
            }
            this.updateStatus(SyncStatus.IDLE);
        } catch (error) {
            this.updateStatus(SyncStatus.ERROR);
            throw error;
        }
    }


    async clearLocalStores(stores: string | string[]): Promise<void> {
        try {
            this.updateStatus(SyncStatus.OPERATING);
            const localAdapter = await this.localCoordinator.getAdapter();
            const availableStores = await localAdapter.getStores();
            const storesToClear = Array.isArray(stores) ? stores : [stores];
            const invalidStores = storesToClear.filter(store => !availableStores.includes(store));
            if (invalidStores.length > 0) {
                throw new Error(`Invalid stores: ${invalidStores.join(', ')}`);
            }
            const clearPromises = storesToClear.map(async (store) => {
                try {
                    const result = await localAdapter.clearStore(store);
                    if (!result) {
                        console.warn(`Failed to clear store: ${store}`);
                    }
                    return { store, success: result };
                } catch (error) {
                    console.error(`Error clearing store ${store}:`, error);
                    return { store, success: false };
                }
            });
            const results = await Promise.all(clearPromises);
            const failures = results.filter(r => !r.success);
            if (failures.length > 0) {
                throw new Error(`Failed to clear stores: ${failures.map(f => f.store).join(', ')}`);
            }
            await this.localCoordinator.initSync();
            this.updateStatus(SyncStatus.IDLE);
        } catch (error) {
            this.updateStatus(SyncStatus.ERROR);
            throw error;
        }
    }


    async countCloudStoreItems(storeName: string): Promise<number> {
        if (!this.cloudCoordinator) {
            throw new Error('Cloud adapter not set');
        }
        try {
            await this.cloudCoordinator.refreshView();
            const cloudView = await this.cloudCoordinator.getCurrentView();
            let count = 0;
            const storeItems = cloudView.getByStore(storeName);
            for (const item of storeItems) {
                if (!item.deleted) {
                    count++;
                }
            }
            return count;
        } catch (error) {
            throw new Error(`Failed to count items in cloud store ${storeName}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }



    // 实例获取
    getlocalCoordinator(): Coordinator {
        return this.localCoordinator;
    }

    // 获取本地数据库适配器
    getlocalAdapter(): DatabaseAdapter {
        return this.localCoordinator.adapter;
    }

    getCloudAdapter(): DatabaseAdapter | undefined {
        return this.cloudCoordinator?.adapter;
    }


    // 清理方法
    dispose(): void {
        this.disableAutoSync();
        this.syncStatus = SyncStatus.OFFLINE;
        this.disconnectCloud();
        this.isInitialized = false;
    }

    // 断开连接
    disconnectCloud(): void {
        this.cloudCoordinator = undefined;
        this.updateStatus(SyncStatus.OFFLINE);
    }


    // 私有辅助方法
    private updateStatus(status: SyncStatus): void {
        if (this.syncStatus === status) return;
        this.syncStatus = status;
        if (this.options.onStatusUpdate) {
            try {
                this.options.onStatusUpdate(status);
            } catch (error) {
                console.error('Status update callback error:', error);
            }
        }
    }

}

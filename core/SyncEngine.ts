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
        this.localCoordinator.onDataChanged(() => this.handleDataChange());
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
        const items = Array.isArray(data) ? data : [data];
        const savedItems = await this.localCoordinator.putBulk(storeName, items, false);
        return savedItems;
    }


    async delete(storeName: string, ids: string | string[]): Promise<void> {
        await this.ensureInitialized();
        const idsToDelete = Array.isArray(ids) ? ids : [ids];
        await this.localCoordinator.deleteBulk(storeName, idsToDelete);
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
            console.log('[SyncEngine] Sync completed:', pullResult, pushResult);
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
            const { toUpload } = SyncView.diffViews(localView, cloudView);
            if (toUpload.length === 0) {
                this.updateStatus(SyncStatus.IDLE);
                return {
                    success: true,
                    syncedAt: Date.now(),
                    stats: { uploaded: 0, downloaded: 0, errors: 0 }
                };
            }
            const changeSet = await this.localCoordinator.extractChanges(toUpload);
            let uploadedCount = 0;
            for (const itemChanges of changeSet.put.values()) {
                uploadedCount += itemChanges.length;
            }
            for (const itemChanges of changeSet.delete.values()) {
                uploadedCount += itemChanges.length;
            }
            await this.cloudCoordinator.applyChanges(changeSet);
            this.options.onChangePushed?.(changeSet);
            this.updateStatus(SyncStatus.IDLE);
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
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Push failed',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
    }



    async pull(): Promise<SyncResult> {
        console.log('[SyncEngine] Pulling...');
        if (!this.cloudCoordinator) {
            console.log('[SyncEngine] Push skipped, cloud adapter not set');
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
            const { toDownload } = SyncView.diffViews(localView, cloudView);
            if (toDownload.length === 0) {
                this.updateStatus(SyncStatus.IDLE);
                return {
                    success: true,
                    syncedAt: Date.now(),
                    stats: { uploaded: 0, downloaded: 0, errors: 0 }
                };
            }
            const changeSet = await this.cloudCoordinator.extractChanges(toDownload);
            let downloadedCount = 0;
            for (const itemChanges of changeSet.put.values()) {
                downloadedCount += itemChanges.length;
            }
            for (const itemChanges of changeSet.delete.values()) {
                downloadedCount += itemChanges.length;
            }
            // 应用到本地
            await this.localCoordinator.applyChanges(changeSet);
            this.options.onChangePulled?.(changeSet);
            this.updateStatus(SyncStatus.IDLE);
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
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Pull failed',
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
            pullInterval: pullInterval || currentAutoSync.pullInterval || 30000
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
        if (!this.options.autoSync?.enabled) return;

        if (this.pushDebounceTimer) {
            clearTimeout(this.pushDebounceTimer);
        }
        console.log('[SyncEngine] Data change detected, scheduling push task');
        this.pushDebounceTimer = setTimeout(async () => {
            if (this.syncStatus !== SyncStatus.IDLE) return;
            try {
                await this.push();
            } catch (error) {
                console.error('[SyncEngine] Push task failed:', error);
            }
        }, this.options.autoSync.pushDebounce);
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



    // 实例获取
    async getlocalCoordinator(): Promise<Coordinator> {
        return this.localCoordinator;
    }

    // 获取本地数据库适配器
    async getlocalAdapter(): Promise<DatabaseAdapter> {
        return await this.localCoordinator.getAdapter();
    }

    async getCloudAdapter(): Promise<DatabaseAdapter | undefined> {
        if (!this.cloudCoordinator) return undefined;
        return await this.cloudCoordinator.getAdapter();
    }


    // 清理方法
    dispose(): void {
        this.disableAutoSync();
        this.syncStatus = SyncStatus.OFFLINE;
        this.localCoordinator.onDataChanged(() => { });
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

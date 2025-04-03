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
    private periodicSyncTimer?: ReturnType<typeof setInterval>; // 自动同步定时器
    private changeDebounceTimer?: ReturnType<typeof setTimeout>;    // 数据变更防抖定时器


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
                interval: 30000,
                retryDelay: 1000,
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
                this.enableAutoSync(this.options.autoSync.interval);
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
    async sync(force: boolean = false): Promise<SyncResult> {
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        try {
            const pullResult = await this.pull(force);
            const pushResult = await this.push(force);
            this.updateStatus(SyncStatus.IDLE);
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


    async push(force: boolean = false): Promise<SyncResult> {
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }

        try {
            // 获取本地和云端视图
            if (force) {
                await this.cloudCoordinator.refreshView();
                await this.localCoordinator.refreshView();
            }
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
            this.updateStatus(SyncStatus.UPLOADING);
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



    async pull(force: boolean = false): Promise<SyncResult> {
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        try {
            if (force) {
                await this.cloudCoordinator.refreshView();
                await this.localCoordinator.refreshView();
            }
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
            this.updateStatus(SyncStatus.DOWNLOADING);
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
    enableAutoSync(interval?: number): void {
        if (this.periodicSyncTimer) {
            clearInterval(this.periodicSyncTimer);
        }
        this.options.autoSync = {
            ...this.options.autoSync,
            enabled: true,
            interval: interval || this.options.autoSync?.interval || 5000
        };
        console.log('[SyncEngine] Enabling auto sync with interval:', this.options.autoSync.interval);
        // 使用新的执行方法
        this.periodicSyncTimer = setInterval(() => {
            this.executeSyncTask();
        }, this.options.autoSync.interval);
    }


    // 禁用自动同步
    disableAutoSync(): void {
        if (this.periodicSyncTimer) {
            clearInterval(this.periodicSyncTimer);
            this.periodicSyncTimer = undefined;
        }
        if (this.changeDebounceTimer) {
            clearTimeout(this.changeDebounceTimer);
            this.changeDebounceTimer = undefined;
        }
        this.options.autoSync = {
            ...this.options.autoSync,
            enabled: false
        };
    }


    // 实际执行同步任务的函数
    private async executeSyncTask(): Promise<void> {
        if (this.syncStatus !== SyncStatus.IDLE) {
            return;
        }
        try {
            await this.sync(true);
        } catch (error) {
            console.error('[SyncEngine] Sync task failed:', error);
        }
    }


    // 数据变更时触发定期的变更任务
    private handleDataChange(): void {
        if (!this.options.autoSync?.enabled) return;

        if (this.changeDebounceTimer) {
            clearTimeout(this.changeDebounceTimer);
        }
        console.log('[SyncEngine] Data change detected, scheduling sync task');
        this.changeDebounceTimer = setTimeout(() => {
            this.executeSyncTask();
        }, 10000);
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
                this.enableAutoSync(options.autoSync.interval);
            } else {
                this.disableAutoSync();
            }
        }
        return this.options;
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
        // 确保回调被调用
        if (this.options.onStatusUpdate) {
            try {
                this.options.onStatusUpdate(status);
            } catch (error) {
                console.error('Status update callback error:', error);
            }
        }
    }

}

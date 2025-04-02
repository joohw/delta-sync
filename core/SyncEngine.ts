// core/SyncEngine.ts

import {
    ISyncEngine,
    DatabaseAdapter,
    SyncOptions,
    SyncView,
    SyncViewItem,
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
                interval: 5000,
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
    async sync(): Promise<SyncResult> {
        if (this.syncStatus !== SyncStatus.IDLE) {
            return {
                success: false,
                error: `Sync already in progress, current status: ${SyncStatus[this.syncStatus]}`,
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        try {
            // Download phase
            this.updateStatus(SyncStatus.DOWNLOADING);
            const pullResult = await this.pull();
            if (!pullResult.success) {
                throw new Error(pullResult.error || 'Pull operation failed');
            }
            // Upload phase
            this.updateStatus(SyncStatus.UPLOADING);
            const pushResult = await this.push();
            if (!pushResult.success) {
                throw new Error(pushResult.error || 'Push operation failed');
            }
            this.updateStatus(SyncStatus.IDLE);
            return {
                success: true,
                syncedAt: Date.now(),
                stats: {
                    uploaded: pushResult.stats?.uploaded || 0,
                    downloaded: pullResult.stats?.downloaded || 0,
                    errors: 0
                }
            };
        } catch (error) {
            console.error('Sync failed:', error);
            this.updateStatus(SyncStatus.ERROR);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
    }



    async push(): Promise<SyncResult> {
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        try {
            this.updateStatus(SyncStatus.UPLOADING);
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
            // 按store分组处理数据
            const storeGroups = this.groupByStore(toUpload);
            let uploadedCount = 0;
            for (const [storeName, items] of storeGroups) {
                const batches = this.splitIntoBatches(items, this.options.batchSize!);
                for (const batch of batches) {
                    const data = await this.localCoordinator.readBulk(
                        storeName,
                        batch.map(item => item.id)
                    );
                    await this.cloudCoordinator.putBulk(storeName, data);
                    this.options.onChangePushed?.(data);
                    uploadedCount += data.length;
                }
            }
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
            console.error('Push failed:', error);
            this.updateStatus(SyncStatus.ERROR);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Push failed',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
    }





    async pull(): Promise<SyncResult> {
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        try {
            this.updateStatus(SyncStatus.DOWNLOADING);
            // Get views
            const localView = await this.localCoordinator.getCurrentView();
            const cloudView = await this.cloudCoordinator.getCurrentView();
            // Calculate differences
            const { toDownload } = SyncView.diffViews(localView, cloudView);
            if (toDownload.length === 0) {
                this.updateStatus(SyncStatus.IDLE);
                return {
                    success: true,
                    syncedAt: Date.now(),
                    stats: { uploaded: 0, downloaded: 0, errors: 0 }
                };
            }
            // Download and process in batches
            const batches = this.splitIntoBatches(toDownload, this.options.batchSize!);
            let downloadedCount = 0;
            for (const batch of batches) {
                const items = await this.cloudCoordinator.readBulk(
                    batch[0].store,
                    batch.map(item => item.id)
                );
                await this.localCoordinator.putBulk(batch[0].store, items);
                this.options.onChangePulled?.(items);
                downloadedCount += items.length;
            }
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
            console.error('Pull failed:', error);
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


    private groupByStore(items: SyncViewItem[]): Map<string, SyncViewItem[]> {
        const groups = new Map<string, SyncViewItem[]>();
        for (const item of items) {
            if (!groups.has(item.store)) {
                groups.set(item.store, []);
            }
            groups.get(item.store)!.push(item);
        }
        return groups;
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
        this.periodicSyncTimer = setInterval(() => {
            this.sync();
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

    // 数据变更时触发定期的变更任务
    private handleDataChange(): void {
        if (!this.options.autoSync?.enabled) return;
        if (this.changeDebounceTimer) {
            clearTimeout(this.changeDebounceTimer);
        }
        this.changeDebounceTimer = setTimeout(async () => {
            const result = await this.sync();
            if (!result.success) {
                console.error('Auto sync failed:', result.error);
            }
        }, 10000);
    }


    // 配置更新
    updateSyncOptions(options: Partial<SyncOptions>): void {
        this.options = this.mergeDefaultOptions({
            ...this.options,
            ...options
        });
        if (options.autoSync) {
            if (options.autoSync.enabled) {
                this.enableAutoSync(options.autoSync.interval);
            } else {
                this.disableAutoSync();
            }
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
    }


    // 私有辅助方法
    private updateStatus(status: SyncStatus): void {
        if (this.syncStatus === status) return;
        this.syncStatus = status;
        this.options.onStatusUpdate?.(status);
        if (process.env.NODE_ENV === 'development') {
            // console.log('Sync status changed to:', SyncStatus[status]);
        }
    }


    private splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
        const batches: T[][] = [];
        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }
        return batches;
    }


}

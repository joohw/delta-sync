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
    private syncStatus: SyncStatus = SyncStatus.OFFLINE;
    private isInitialized: boolean = false;
    private pullTimer?: ReturnType<typeof setInterval>;
    private pushDebounceTimer?: ReturnType<typeof setTimeout>;


    constructor(
        localAdapter: DatabaseAdapter,
        options: SyncOptions = {}
    ) {
        this.localCoordinator = new Coordinator(localAdapter);
        this.options = this.mergeDefaultOptions(options);
        console.log('Powered by Delta Sync 0.1.5');
    }


    private mergeDefaultOptions(options: SyncOptions): SyncOptions {
        return {
            autoSync: {
                enabled: false,
                pullInterval: 60000,
                pushDebounce: 10000,
                retryDelay: 3000,
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


    async sync(): Promise<SyncResult> {
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
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        const canPull = await this.checkPullAvailable();
        if (!canPull) {
            this.updateStatus(SyncStatus.ERROR);
            return {
                success: false,
                error: 'Pull not available',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        try {
            this.updateStatus(SyncStatus.DOWNLOADING);
            await this.cloudCoordinator.rebuildSyncView();
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
            // 分批处理逻辑
            const batchSize = this.options.batchSize || 100;
            let totalDownloaded = 0;
            let errors = 0;
            // 按批次处理
            for (let i = 0; i < toDownload.length; i += batchSize) {
                const currentBatch = toDownload.slice(i, i + batchSize);
                try {
                    const batchChangeSet = await this.cloudCoordinator.extractChanges(currentBatch);
                    let batchItemCount = 0;
                    for (const itemChanges of batchChangeSet.put.values()) {
                        batchItemCount += itemChanges.length;
                    }
                    for (const itemChanges of batchChangeSet.delete.values()) {
                        batchItemCount += itemChanges.length;
                    }
                    await this.localCoordinator.applyChanges(batchChangeSet);
                    totalDownloaded += batchItemCount;
                    
                    if (this.options.onSyncProgress) {
                        this.options.onSyncProgress({
                            processed: i + currentBatch.length,
                            total: toDownload.length,
                        });
                    }
                } catch (error) {
                    console.error(`Error processing batch ${i / batchSize + 1}:`, error);
                    errors++;
                }
            }
            
            // 更新可能的最新版本
            if (toDownload.length > 0) {
                const latestVersion = Math.max(...toDownload.map(item => item._ver));
                if (latestVersion && this.options.onVersionUpdate) {
                    this.options.onVersionUpdate(latestVersion);
                }
            }
            
            this.options.onChangePulled?.({ delete: new Map(), put: new Map() });
            this.updateStatus(SyncStatus.IDLE);
            return {
                success: errors === 0,
                syncedAt: Date.now(),
                stats: {
                    uploaded: 0,
                    downloaded: totalDownloaded,
                    errors
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
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            return {
                success: false,
                error: 'Cloud adapter not set',
                stats: { uploaded: 0, downloaded: 0, errors: 1 }
            };
        }
        const canPush = await this.checkPushAvailable();
        if (!canPush) {
            this.updateStatus(SyncStatus.ERROR);
            return {
                success: false,
                error: 'Push not available',
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
                return { success: true, syncedAt: Date.now(), stats: { uploaded: 0, downloaded: 0, errors: 0 } };
            }
            
            // 分批处理逻辑
            const batchSize = this.options.batchSize || 100;
            let uploadedCount = 0;
            let errorsCount = 0;
            
            for (let i = 0; i < toUpload.length; i += batchSize) {
                try {
                    const batchItems = toUpload.slice(i, i + batchSize);
                    console.log(`处理上传批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(toUpload.length / batchSize)}`);
                    const batchChangeSet = await this.localCoordinator.extractChanges(batchItems);
                    let batchUploadCount = 0;
                    for (const itemChanges of batchChangeSet.put.values()) {
                        batchUploadCount += itemChanges.length;
                    }
                    for (const itemChanges of batchChangeSet.delete.values()) {
                        batchUploadCount += itemChanges.length;
                    }
                    await this.cloudCoordinator.applyChanges(batchChangeSet);
                    uploadedCount += batchUploadCount;
                } catch (error) {
                    console.error('[SyncEngine] Error processing batch:', error);
                    errorsCount++;
                }
            }
            
            // 版本更新处理
            if (toUpload.length > 0) {
                const latestVersion = Math.max(...toUpload.map(item => item._ver));
                if (latestVersion && this.options.onVersionUpdate) {
                    this.options.onVersionUpdate(latestVersion);
                }
            }
            
            this.options.onChangePushed?.({ delete: new Map(), put: new Map() });
            this.updateStatus(SyncStatus.IDLE);
            return {
                success: errorsCount === 0,
                syncedAt: Date.now(),
                stats: {
                    uploaded: uploadedCount,
                    downloaded: 0,
                    errors: errorsCount
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
        this.options.autoSync.pullInterval;
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


    // callback
    private handleDataChange(): void {
        if (!this.options.autoSync?.enabled) {
            return;
        }
        if (!this.cloudCoordinator) {
            return;
        }
        if (this.pushDebounceTimer) {
            clearTimeout(this.pushDebounceTimer);
        }
        this.pushDebounceTimer = setTimeout(async () => {
            try {
                if (this.canTriggerSync()) {
                    await this.push();
                } else {
                    console.warn('[SyncEngine] Sync skipped caused by checking process')
                }
            } catch (error) {
                console.error('[SyncEngine] Scheduled push failed:', error);
            }
        }, this.options.autoSync?.pushDebounce || 10000);
    }



    private canTriggerSync(): boolean {
        const isAutoSyncEnabled = this.options.autoSync?.enabled === true;
        const canSync = Boolean(
            isAutoSyncEnabled &&
            this.cloudCoordinator !== undefined &&
            ![SyncStatus.ERROR, SyncStatus.UPLOADING, SyncStatus.DOWNLOADING].includes(this.syncStatus)
        );
        return canSync;
    }


    updateSyncOptions(options: Partial<SyncOptions>): SyncOptions {
        this.options = this.mergeDefaultOptions({
            ...this.options,
            ...options
        });
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

    // get local coordinator
    getlocalCoordinator(): Coordinator {
        return this.localCoordinator;
    }


    getCloudCoordinator(): Coordinator | undefined {
        return this.cloudCoordinator;
    }

    // get local adapter
    getlocalAdapter(): DatabaseAdapter {
        return this.localCoordinator.adapter;
    }

    getCloudAdapter(): DatabaseAdapter | undefined {
        return this.cloudCoordinator?.adapter;
    }


    // dispose
    dispose(): void {
        this.disableAutoSync();
        this.syncStatus = SyncStatus.OFFLINE;
        this.disconnectCloud();
        this.isInitialized = false;
    }


    disconnectCloud(): void {
        this.cloudCoordinator = undefined;
        this.updateStatus(SyncStatus.OFFLINE);
    }


    private async checkPullAvailable(): Promise<boolean> {
        if (this.options.onPullAvailableCheck) {
            try {
                const result = await Promise.resolve(this.options.onPullAvailableCheck());
                if (!result) {
                }
                return result;
            } catch (error) {
                console.error('[SyncEngine] Pull availability check failed:', error);
                return false;
            }
        }
        return true;
    }


    private async checkPushAvailable(): Promise<boolean> {
        if (this.options.onPushAvailableCheck) {
            try {
                const result = await Promise.resolve(this.options.onPushAvailableCheck());
                return result;
            } catch (error) {
                console.error('[SyncEngine] Push availability check failed:', error);
                return false;
            }
        }
        return true;
    }


    // private methods
    private updateStatus(status: SyncStatus): void {
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

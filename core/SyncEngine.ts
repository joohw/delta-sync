// core/SyncEngine.ts

import {
    DatabaseAdapter,
    DataChange,
    DataChangeSet,
    TOMBSTONE_STORE,
    SyncStatus,
} from './types';
import { SyncViewItem, getViewDiff } from './SyncView';
import { syncFromDiff, applyChangesToAdapter } from './sync';
import { SyncOptions, createDefaultOptions } from './option';
import { getDeltaViewDiff } from './checkpoints'


export class SyncEngine {

    private options: SyncOptions;
    private localAdapter: DatabaseAdapter;
    private cloudAdapter?: DatabaseAdapter;
    private syncStatus: SyncStatus = SyncStatus.OFFLINE;
    private isInitialized: boolean = false;
    private pullTimer?: ReturnType<typeof setInterval>;
    private pushDebounceTimer?: ReturnType<typeof setTimeout>;
    private storesToSync: string[] = [];
    private lastSyncedVersion: number = 0;


    // 待同步的数据库更改
    private pendingChanges: DataChangeSet = {
        put: new Map<string, DataChange[]>(),
        delete: new Map<string, DataChange[]>(),
    };


    constructor(
        localAdapter: DatabaseAdapter,
        storesToSync: string[],
        options: SyncOptions = {}
    ) {
        this.storesToSync = storesToSync;
        this.localAdapter = localAdapter;
        this.options = createDefaultOptions(options);
        console.log('Powered by Delta Sync 0.1.13');
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
        this.cloudAdapter = cloudAdapter
    }


    // 数据操作方法
    async save<T extends { id: string }>(
        storeName: string,
        data: T | T[]
    ): Promise<T[]> {
        await this.ensureInitialized();
        try {
            const items = Array.isArray(data) ? data : [data];
            const newVersion = Date.now();
            const itemsWithVersion = items.map(item => ({
                ...item,
                _ver: newVersion
            }));
            const results = await this.localAdapter.putBulk(storeName, itemsWithVersion);
            this.cacheDataChanges(storeName, results, 'put');
            this.handleDataChange();
            return results;
        } catch (error) {
            console.error('Save operation failed:', error);
            throw error;
        }
    }

    // 添加数据到对应的墓碑中
    private async addTombstones(items: SyncViewItem[]): Promise<void> {
        if (!this.storesToSync.includes(TOMBSTONE_STORE)) {
            console.warn(`[Coordinator] Skipping tombstone addition - TOMBSTONE_STORE not supported`);
            return;
        }
        await this.localAdapter.putBulk(TOMBSTONE_STORE, items);
    }


    // 删除数据
    async delete(storeName: string, ids: string | string[]): Promise<void> {
        await this.ensureInitialized();
        try {
            const idsToDelete = Array.isArray(ids) ? ids : [ids];
            await this.localAdapter.deleteBulk(storeName, idsToDelete);
            const currentVersion = Date.now();
            const tombstones = idsToDelete.map(id => ({
                id,
                store: storeName, // **保存原始store名称**
                _ver: currentVersion,
                deleted: true
            }));
            await this.addTombstones(tombstones);
            this.cacheDataChanges(storeName, idsToDelete.map(id => ({ id, _ver: Date.now() })), 'delete');
            this.handleDataChange();
        } catch (error) {
            console.error('Delete operation failed:', error);
            throw error;
        }
    }



    // 记录本地的即时变更以便及时同步
    private cacheDataChanges<T extends { id: string }>(
        storeName: string,
        items: T[] | { id: string; _ver: number }[],
        operation: 'put' | 'delete'
    ): void {
        const targetMap = operation === 'put' ? this.pendingChanges.put : this.pendingChanges.delete;
        if (operation === 'put') {
            const putItems = items as T[];
            const changes = putItems.map(item => ({
                id: item.id,
                data: item,
                _ver: (item as any)._ver || Date.now()
            }));
            targetMap.set(storeName, changes);
        } else {
            const deleteItems = items as { id: string; _ver: number }[];
            const changes = deleteItems.map(item => ({
                id: item.id,
                _ver: item._ver
            }));
            targetMap.set(storeName, changes);
        }
    }


    // 增量拉取，只拉取某一个时间段之后的最新数据
    async incrementalPull(): Promise<void> {
        console.log('[SyncEngine] Incremental pulling from cloud...');
        if (!this.cloudAdapter) {
            this.updateStatus(SyncStatus.OFFLINE);
            return;
        }
        try {
            this.updateStatus(SyncStatus.CHECKING);
            const diff = await getDeltaViewDiff(this.cloudAdapter, this.localAdapter, this.storesToSync);
            if (diff.toDownload.length === 0 && diff.toDelete.length === 0) {
                console.log('[SyncEngine] No incremental changes found');
                return;
            }
            this.updateStatus(SyncStatus.DOWNLOADING);
            await syncFromDiff(
                this.cloudAdapter,
                this.localAdapter,
                diff,
                {
                    batchSize: this.options.batchSize || 100,
                    onProgress: this.options.onSyncProgress,
                    onChangesApplied: this.options.onChangePulled,
                }
            );
            this.updateStatus(SyncStatus.IDLE);
        } catch (error) {
            this.updateStatus(SyncStatus.ERROR);
            console.error('[SyncEngine] Incremental pull failed:', error);
        }
    }



    // 全量拉取最新的云端数据
    async pull() {
        console.log('[SyncEngine] Pulling data from cloud...')
        if (!this.cloudAdapter) {
            this.updateStatus(SyncStatus.OFFLINE);
            return;
        }
        if (!await this.checkPullAvailable()) {
            this.updateStatus(SyncStatus.ERROR);
            return;
        }
        try {
            this.updateStatus(SyncStatus.CHECKING);
            const diff = await getViewDiff(this.cloudAdapter, this.localAdapter, this.storesToSync);
            this.updateStatus(SyncStatus.DOWNLOADING);
            await syncFromDiff(
                this.cloudAdapter,
                this.localAdapter,
                diff,
                {
                    batchSize: this.options.batchSize || 100,
                    onProgress: this.options.onSyncProgress,
                    onChangesApplied: this.options.onChangePulled,
                    onVersionUpdated: (version) => {
                        console.log('本地数据的最新版本已经更新到', version)
                        this.lastSyncedVersion = version;
                        this.options.onVersionUpdate && this.options.onVersionUpdate(version);
                    }
                }
            );
            this.clearPendingChanges();
            this.updateStatus(SyncStatus.IDLE);
            return;
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



    async push() {
        console.log('[SyncEngine] Pushing data to cloud...');
        if (!this.cloudAdapter) {
            this.updateStatus(SyncStatus.OFFLINE);
            return
        }
        if (!await this.checkPushAvailable()) {
            this.updateStatus(SyncStatus.ERROR);
            return
        }
        try {
            this.updateStatus(SyncStatus.CHECKING);
            const diff = await getViewDiff(this.localAdapter, this.cloudAdapter, this.storesToSync);
            this.updateStatus(SyncStatus.UPLOADING);
            await syncFromDiff(
                this.localAdapter,
                this.cloudAdapter,
                diff,
                {
                    batchSize: this.options.batchSize || 100,
                    onProgress: this.options.onSyncProgress,
                }
            );
            this.clearPendingChanges();
            this.updateStatus(SyncStatus.IDLE);
            return;
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


    // 全量同步
    async fullSync() {
        console.log('[SyncEngine] Starting full sync...');
        if (!this.cloudAdapter) {
            this.updateStatus(SyncStatus.OFFLINE);
            return;
        }
        try {
            await this.pull();
            await this.push();
        } catch (error) {
            this.updateStatus(SyncStatus.ERROR);
            console.error('[SyncEngine] Sync failed:', error);
            return
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


    private clearPendingChanges(): void {
        this.pendingChanges.put.clear();
        this.pendingChanges.delete.clear();
    }



    // 即时同步本地的最新改动
    private async instantSync() {
        console.log('[SyncEngine] Instant syncing data to cloud...')
        if (!this.cloudAdapter) {
            this.updateStatus(SyncStatus.OFFLINE);
            return;
        }
        if (!this.hasPendingChanges()) {
            return;
        }
        if (!await this.checkPushAvailable()) {
            this.updateStatus(SyncStatus.ERROR);
            return;
        }
        try {
            this.updateStatus(SyncStatus.UPLOADING);
            let totalUploaded = 0;
            if (this.hasPendingChanges()) {
                await applyChangesToAdapter(
                    this.cloudAdapter,
                    this.pendingChanges,
                    this.storesToSync);
                this.options.onChangePushed && this.options.onChangePushed(this.pendingChanges);
            }
            this.clearPendingChanges();
            this.updateStatus(SyncStatus.IDLE);
            return;
        } catch (error) {
            this.updateStatus(SyncStatus.ERROR);
            console.error('[SyncEngine] Instant sync failed:', error);
            return;
        }
    }



    // callback
    private handleDataChange(): void {
        if (!this.options.autoSync?.enabled) {
            return;
        }
        if (!this.cloudAdapter) {
            return;
        }
        if (this.pushDebounceTimer) {
            clearTimeout(this.pushDebounceTimer);
        }
        this.pushDebounceTimer = setTimeout(async () => {
            try {
                if (this.canTriggerSync()) {
                    await this.instantSync();
                } else {
                    console.warn('[SyncEngine] Instant sync skipped caused by checking process');
                }
            } catch (error) {
                console.error('[SyncEngine] Scheduled instant sync failed:', error);
            }
        }, this.options.autoSync?.pushDebounce || 10000);
    }


    // 更新同步设置
    public updateSyncOptions(options: Partial<SyncOptions>): SyncOptions {
        this.options = createDefaultOptions({
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
        if (!this.cloudAdapter) {
            throw new Error('Cloud adapter not set');
        }
        try {
            this.updateStatus(SyncStatus.OPERATING);
            const cloudAdapter = await this.cloudAdapter;
            const storesToClear = Array.isArray(stores) ? stores : [stores];
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
            const storesToClear = Array.isArray(stores) ? stores : [stores];
            const invalidStores = storesToClear.filter(store => !this.storesToSync.includes(store));
            if (invalidStores.length > 0) {
                throw new Error(`Invalid stores: ${invalidStores.join(', ')}`);
            }
            const clearPromises = storesToClear.map(async (store) => {
                try {
                    const result = await this.localAdapter.clearStore(store);
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


    // dispose
    dispose(): void {
        this.disableAutoSync();
        this.clearPendingChanges();
        this.syncStatus = SyncStatus.OFFLINE;
        this.isInitialized = false;
    }


    // 检查当前是否可以触发同步
    private canTriggerSync(): boolean {
        const isAutoSyncEnabled = this.options.autoSync?.enabled === true;
        const canSync = Boolean(
            isAutoSyncEnabled &&
            this.cloudAdapter !== undefined &&
            ![SyncStatus.ERROR, SyncStatus.UPLOADING, SyncStatus.DOWNLOADING].includes(this.syncStatus)
        );
        return canSync;
    }


    private hasPendingChanges(): boolean {
        return this.pendingChanges.put.size > 0 || this.pendingChanges.delete.size > 0
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
                if (result === false) {
                    this.updateStatus(SyncStatus.REJECTED);
                    return false;
                }
                return true;
            } catch (error) {
                console.error('[SyncEngine] Push availability check failed:', error);
                throw new Error(error instanceof Error ? error.message : 'Push availability check failed');
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

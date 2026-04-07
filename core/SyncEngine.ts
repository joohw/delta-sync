// core/SyncEngine.ts

import {
    DatabaseAdapter,
    DataChange,
    DataChangeSet,
    SyncStatus,
    TOMBSTONE_STORE
} from './types';
import { getRoundTripDiff } from './SyncView';
import { syncFromDiff, applyChangesToAdapter } from './sync';
import { SyncOptions, createDefaultOptions } from './option';
import { clearOldTombstones } from './clear';
import packageJson from '../package.json';


export class SyncEngine {

    localAdapter: DatabaseAdapter;
    cloudAdapter?: DatabaseAdapter;
    private options: SyncOptions;
    private syncStatus: SyncStatus = SyncStatus.OFFLINE;
    private isInitialized: boolean = false;
    private syncTimer?: ReturnType<typeof setInterval>;
    private pushDebounceTimer?: ReturnType<typeof setTimeout>;
    private storesToSync: string[] = [];
    /**
     * 仅由 {@link sync} 在整轮「先推后拉」成功结束后，根据本轮应用的最大 `_ver` 更新。
     * 作为默认 `since` 用于增量 `listStoreItems`（`_ver > since`）。
     */
    private checkpoint: number = 0;


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
        console.log(`Powered by Delta Sync ${packageJson.version}`);
    }


    getCheckpoint(): number {
        return this.checkpoint;
    }

    /** Restore persisted checkpoint after restart (e.g. from last successful sync). */
    setCheckpoint(value: number): void {
        if (typeof value === 'number' && !Number.isNaN(value) && value >= 0) {
            this.checkpoint = value;
        }
    }

    private resolveSince(explicitSince?: number): number {
        return explicitSince !== undefined ? explicitSince : this.checkpoint;
    }

    private advanceCheckpointFromSyncedVersion(version: number): void {
        if (typeof version === 'number' && !Number.isNaN(version)) {
            this.checkpoint = Math.max(this.checkpoint, version);
        }
    }


    async initialize(): Promise<void> {
        clearOldTombstones(this.localAdapter)
        if (this.isInitialized) return;
        try {
            if (this.options.autoSync?.enabled) {
                this.enableAutoSync(this.options.autoSync.pullInterval);
            }
            this.isInitialized = true;
        } catch (error) {
            console.error('Failed to initialize sync engine:', error);
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


    // 删除数据
    async delete(storeName: string, ids: string | string[]): Promise<void> {
        await this.ensureInitialized();
        try {
            const idsToDelete = Array.isArray(ids) ? ids : [ids];
            await this.localAdapter.deleteBulk(storeName, idsToDelete);
            const currentVersion = Date.now();
            // 把墓碑存到墓碑表
            const itemsWithDeleteMark = idsToDelete.map(id => ({
                id,
                store: storeName, // 记录原始store
                _ver: currentVersion,
                deleted: true
            }));
            await this.localAdapter.putBulk(TOMBSTONE_STORE, itemsWithDeleteMark);
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




    /**
     * 双向同步：本地与云端各 **list 一次** 元数据，{@link getRoundTripDiff} 一次得到上传/拉取两个 diff，再先推后拉。
     * checkpoint **仅在本方法末尾**根据本轮应用的最大 `_ver` 更新一次。
     * @param since 显式水位；省略则用内部 `checkpoint`。全量列举可用 `sync(stores, 0)`（视适配器对 `since` 的约定）。
     */
    async sync(stores: string[] = this.storesToSync, since?: number): Promise<void> {
        // 允许从 ERROR 状态恢复，但阻止其他忙碌状态
        if (this.syncStatus !== SyncStatus.IDLE && this.syncStatus !== SyncStatus.ERROR) {
            console.warn('[DeltySync] Sync is busy, skip sync');
            return;
        }
        console.log('[DeltySync] Syncing with cloud (push then pull)...');
        if (!this.cloudAdapter) {
            this.updateStatus(SyncStatus.OFFLINE);
            return;
        }
        if (!await this.checkPullAvailable()) {
            this.updateStatus(SyncStatus.ERROR);
            return;
        }
        if (!await this.checkPushAvailable()) {
            this.updateStatus(SyncStatus.ERROR);
            return;
        }
        const syncSince = this.resolveSince(since);
        let pullMaxVerInRound = 0;
        const cloud = this.cloudAdapter;
        try {
            this.updateStatus(SyncStatus.CHECKING);
            const { upload, pull } = await getRoundTripDiff(
                this.localAdapter,
                cloud,
                stores,
                syncSince
            );
            this.updateStatus(SyncStatus.UPLOADING);
            await syncFromDiff(
                this.localAdapter,
                cloud,
                upload,
                {
                    batchSize: this.options.batchSize || 100,
                    onProgress: this.options.onSyncProgress,
                    onChangesApplied: this.options.onChangePushed,
                    onVersionUpdated: (version) => {
                        this.options.onVersionUpdate && this.options.onVersionUpdate(version);
                    }
                }
            );
            if (!await this.checkPullAvailable()) {
                this.updateStatus(SyncStatus.ERROR);
                return;
            }
            this.updateStatus(SyncStatus.DOWNLOADING);
            await syncFromDiff(
                cloud,
                this.localAdapter,
                pull,
                {
                    batchSize: this.options.batchSize || 100,
                    onProgress: this.options.onSyncProgress,
                    onChangesApplied: this.options.onChangePulled,
                    onVersionUpdated: (version) => {
                        pullMaxVerInRound = Math.max(pullMaxVerInRound, version);
                        this.options.onVersionUpdate && this.options.onVersionUpdate(version);
                    }
                }
            );
            if (pullMaxVerInRound > 0) {
                this.advanceCheckpointFromSyncedVersion(pullMaxVerInRound);
            }
            this.clearPendingChanges();
            this.updateStatus(SyncStatus.IDLE);
            return;
        } catch (error) {
            this.updateStatus(SyncStatus.ERROR);
            console.error('[DeltySync] Sync failed:', error);
            return;
        }
    }



    enableAutoSync(pullInterval?: number): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
        }
        const currentAutoSync = this.options.autoSync || {};
        this.options.autoSync = {
            ...currentAutoSync,
            enabled: true,
            pullInterval: pullInterval || currentAutoSync.pullInterval || 30000000
        };
        this.options.autoSync.pullInterval;
        this.syncTimer = setInterval(() => {
            this.executeSyncTask();
        }, this.options.autoSync.pullInterval);
    }



    disableAutoSync(): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = undefined;
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


    private async executeSyncTask(): Promise<void> {
        // 允许从 ERROR 状态恢复，但阻止其他忙碌状态
        if (this.syncStatus !== SyncStatus.IDLE && this.syncStatus !== SyncStatus.ERROR) {
            return;
        }
        if (!this.cloudAdapter) {
            this.updateStatus(SyncStatus.OFFLINE);
            return;
        }
        try {
            await this.sync(this.storesToSync);
        } catch (error) {
            console.error('[DeltySync] Scheduled sync failed:', error);
        }
    }


    private clearPendingChanges(): void {
        this.pendingChanges.put.clear();
        this.pendingChanges.delete.clear();
    }



    // 即时上传本地的最新改动
    private async instantPush() {
        console.log('[DeltySync] Instant syncing data to cloud...')
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
            if (this.hasPendingChanges()) {
                await applyChangesToAdapter(this.cloudAdapter, this.pendingChanges);
                this.options.onChangePushed && this.options.onChangePushed(this.pendingChanges);
            }
            this.clearPendingChanges();
            this.updateStatus(SyncStatus.IDLE);
            return;
        } catch (error) {
            this.updateStatus(SyncStatus.ERROR);
            console.error('[DeltySync] Instant sync failed:', error);
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
                    await this.instantPush();
                } else {
                    console.warn('[DeltySync] Instant sync skipped caused by checking process');
                }
            } catch (error) {
                console.error('[DeltySync] Scheduled instant sync failed:', error);
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


    // 检查当前是否可以触发同步
    private canTriggerSync(): boolean {
        const isAutoSyncEnabled = this.options.autoSync?.enabled === true;
        // 允许从 ERROR 状态恢复，但阻止正在进行的同步操作
        const canSync = Boolean(
            isAutoSyncEnabled &&
            this.cloudAdapter !== undefined &&
            ![SyncStatus.UPLOADING, SyncStatus.DOWNLOADING, SyncStatus.CHECKING].includes(this.syncStatus)
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
                    return false;
                }
            } catch (error) {
                console.error('[DeltySync] Pull availability check failed:', error);
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
                console.error('[DeltySync] Push availability check failed:', error);
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

    // dispose
    dispose(): void {
        this.disableAutoSync();
        this.clearPendingChanges();
        this.syncStatus = SyncStatus.OFFLINE;
        this.isInitialized = false;
        this.cloudAdapter = undefined;
        this.checkpoint = 0;
    }

}

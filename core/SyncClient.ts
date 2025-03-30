// core/SyncClient.ts
// Provides a simple and easy-to-use synchronization client API, encapsulating internal synchronization complexity

import {
    BaseModel,
    DatabaseAdapter,
    SyncResponse,
    Attachment,
    FileItem,
    DataChange
} from './types';
import { LocalCoordinator } from './LocalCoordinator';
import { CloudCoordinator } from './CloudCoordinator';
import { SyncManager } from './SyncManager';
import { EncryptionConfig } from './SyncConfig';
import { SyncConfig, getSyncConfig } from './SyncConfig';
import { testAdapterFunctionality } from '../tester/FunctionTester';

// Synchronization status enumeration
export enum SyncStatus {
    Error = -2,        // Error or offline status
    Offline = -1,      // Error or offline status
    Idle = 0,          // Idle status
    Uploading = 1,     // Upload synchronization in progress
    Downloading = 2,   // Download synchronization in progress
    Operating = 3,     // Operation in progress (clearing notes and other special operations)
    Maintaining = 4,   // Maintenance in progress (cleaning old data, optimizing storage)
}

// Sync client options
export interface SyncClientOptions {
    localAdapter: DatabaseAdapter;
    encryptionConfig?: EncryptionConfig;
    syncConfig?: Partial<SyncConfig>;  // New: synchronization configuration
    onStatus?: (status: SyncStatus) => void;  // Status change callback
    onDataPull?: (changes: DataChange[]) => void;  // Data pull callback
}

// Synchronization status information
export interface ClientStatus {
    currentVersion: number;     // Current data version number
    pendingChanges: number;     // Number of pending changes to be synchronized
    cloudConfigured: boolean;   // Whether cloud is configured
    syncStatus: SyncStatus;     // Current synchronization status
}

// Query options
export interface QueryOptions {
    ids?: string[];    // Specific IDs to query
    limit?: number;    // Query result limit
    offset?: number;   // Query result offset
    since?: number;    // Query version range (greater than this version number)
    sort?: string;     // Sort order (e.g. "name:asc")
}

// Sync client, providing a simple and easy-to-use API to manage local data and synchronization operations
export class SyncClient {
    private localAdapter: DatabaseAdapter;
    private localCoordinator: LocalCoordinator;
    private cloudCoordinator?: CloudCoordinator;
    private syncManager?: SyncManager;
    private config: SyncConfig;
    private currentSyncStatus: SyncStatus = SyncStatus.Idle;
    private onStatusCallback?: (status: SyncStatus) => void;
    private onDataPullCallback?: (changes: DataChange[]) => void;

    // Create sync client
    constructor(options: SyncClientOptions) {
        this.localAdapter = options.localAdapter;
        this.localCoordinator = new LocalCoordinator(
            this.localAdapter,
            options.encryptionConfig
        );
        this.onStatusCallback = options.onStatus;
        this.onDataPullCallback = options.onDataPull;
        // Initialize sync configuration
        this.config = getSyncConfig(options.syncConfig);
        // Automatically initialize local coordinator
        this.initialize();
    }

    // Set status change callback
    setStatusCallback(callback: (status: SyncStatus) => void): void {
        this.onStatusCallback = callback;
    }

    // Set data pull callback
    setDataPullCallback(callback: (changes: DataChange[]) => void): void {
        this.onDataPullCallback = callback;
    }

    // Update sync configuration
    updateSyncConfig(config: Partial<SyncConfig>): void {
        this.config = {
            ...this.config,
            ...config
        };
        console.log("Sync configuration updated:", this.config);
    }

    // Get current sync configuration
    getSyncConfig(): SyncConfig {
        return { ...this.config };
    }

    // Set cloud adapter, enable synchronization functionality
    async setCloudAdapter(cloudAdapter: DatabaseAdapter): Promise<void> {
        this.cloudCoordinator = new CloudCoordinator(cloudAdapter);
        try {
            this.updateSyncStatus(SyncStatus.Operating);
            await this.cloudCoordinator.initialize();
            this.syncManager = new SyncManager(
                this.localCoordinator,
                this.cloudCoordinator
            );
            this.updateSyncStatus(SyncStatus.Idle);
            console.log("Cloud adapter connected, synchronization ready");
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            console.error("Cloud adapter initialization failed:", error);
            this.cloudCoordinator = undefined;
            throw error;
        }
    }

    // Disconnect cloud connection, return to local mode
    disconnectCloud(): void {
        this.cloudCoordinator = undefined;
        this.syncManager = undefined;
        this.updateSyncStatus(SyncStatus.Offline);
        console.log("Cloud connection disconnected, now in local mode");
    }

    // Get current sync status enumeration value
    getCurrentSyncStatus(): SyncStatus {
        return this.currentSyncStatus;
    }

    // Update sync status and trigger callback
    private updateSyncStatus(status: SyncStatus): void {
        this.currentSyncStatus = status;
        if (this.onStatusCallback) {
            this.onStatusCallback(status);
        }
    }

    // Initialize local coordinator
    private async initialize(): Promise<void> {
        try {
            this.updateSyncStatus(SyncStatus.Operating);
            await this.localCoordinator.initialize();
            this.updateSyncStatus(SyncStatus.Idle);
            console.log("Local storage initialization successful");
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            console.error("Local storage initialization failed:", error);
            throw error;
        }
    }

    // Query data
    async query<T extends BaseModel>(storeName: string, options?: QueryOptions): Promise<T[]> {
        try {
            if (options?.ids && options.ids.length > 0) {
                return await this.localAdapter.readBulk<T>(storeName, options.ids);
            } else {
                // 否则使用 readByVersion 并正确传递参数
                const result = await this.localAdapter.readByVersion<T>(
                    storeName, {
                    limit: options?.limit,
                    offset: options?.offset,
                    since: options?.since,
                    order: options?.sort?.includes(':desc') ? 'desc' : 'asc' // 正确处理排序选项
                });
                return result.items;
            }
        } catch (error) {
            console.error(`查询数据失败: ${storeName}`, error);
            throw new Error(`查询 ${storeName} 数据失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    
    // Save data to specified storage
    async save<T extends BaseModel>(storeName: string, data: T | T[]): Promise<T[]> {
        const items = Array.isArray(data) ? data : [data];
        return await this.localCoordinator.putBulk(storeName, items);
    }

    // Delete data from specified storage
    async delete(storeName: string, ids: string | string[]): Promise<void> {
        const itemIds = Array.isArray(ids) ? ids : [ids];
        await this.localCoordinator.deleteBulk(storeName, itemIds);
    }

    // Perform bidirectional synchronization operation
    async sync(): Promise<boolean> {
        if (!this.syncManager) {
            return false;
        }
        try {
            this.currentSyncStatus = SyncStatus.Uploading;
            const success = await this.syncManager.syncAll();
            this.currentSyncStatus = success ? SyncStatus.Idle : SyncStatus.Error;
            return success;
        } catch (error) {
            this.currentSyncStatus = SyncStatus.Error;
            throw error;
        }
    }

    // Only push local changes to cloud
    async push(): Promise<SyncResponse> {
        if (!this.syncManager) {
            return {
                success: false,
                error: "Cloud sync source not configured, please call setCloudAdapter first"
            };
        }
        try {
            this.currentSyncStatus = SyncStatus.Uploading;
            // Use batch size from configuration
            const result = await this.syncManager.pushChanges(this.config.batchSize);
            this.currentSyncStatus = result.success ? SyncStatus.Idle : SyncStatus.Error;
            return result;
        } catch (error) {
            this.currentSyncStatus = SyncStatus.Error;
            throw error;
        }
    }

    // Only pull changes from cloud
    async pull(): Promise<SyncResponse> {
        if (!this.syncManager) {
            return {
                success: false,
                error: "Cloud sync source not configured, please call setCloudAdapter first"
            };
        }
        try {
            this.updateSyncStatus(SyncStatus.Downloading);
            const result = await this.syncManager.pullChanges();
            this.updateSyncStatus(result.success ? SyncStatus.Idle : SyncStatus.Error);
            // If pull is successful and there is a data pull callback and change data, notify of new data
            if (result.success && this.onDataPullCallback && result.changes && result.changes.length > 0) {
                this.onDataPullCallback(result.changes);
            }
            return result;
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            throw error;
        }
    }


    // Get current sync status
    async getClientStatus(): Promise<ClientStatus> {
        const currentVersion = await this.localCoordinator.getCurrentVersion();
        const pendingChanges = await this.localCoordinator.getPendingChanges(0);
        return {
            currentVersion,
            pendingChanges: pendingChanges.length,
            cloudConfigured: !!this.syncManager,
            syncStatus: this.currentSyncStatus
        };
    }


    // Save file attachments
    async saveFiles(files: FileItem[]): Promise<Attachment[]> {
        return await this.localAdapter.saveFiles(files);
    }


    // Read file attachments
    async readFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>> {
        return await this.localAdapter.readFiles(fileIds);
    }

    // Delete file attachments
    async deleteFiles(fileIds: string[]): Promise<{ deleted: string[], failed: string[] }> {
        return await this.localAdapter.deleteFiles(fileIds);
    }


    // Access underlying coordination layer
    getlocalCoordinator(): LocalCoordinator {
        return this.localCoordinator;
    }

    // Access underlying local storage adapter
    getlocalAdapter(): DatabaseAdapter {
        return this.localAdapter;
    }

    testLocalAdapter(): void {
        testAdapterFunctionality(this.localAdapter, "local_adapater_test");
    }

    // Perform maintenance operations, clean up old data
    async maintenance(
        cloudOlderThan: number = 30 * 24 * 60 * 60 * 1000
    ): Promise<void> {
        try {
            this.updateSyncStatus(SyncStatus.Maintaining);
            // Local maintenance
            await this.localCoordinator.performMaintenance();
            // Cloud maintenance (if configured)
            if (this.cloudCoordinator) {
                await this.cloudCoordinator.performMaintenance(cloudOlderThan);
            }
            this.updateSyncStatus(SyncStatus.Idle);
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            throw error;
        }
    }


}
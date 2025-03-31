// core/SyncClient.ts
// Provides a simple and easy-to-use synchronization client API, encapsulating internal synchronization complexity

import {
    BaseModel,
    DatabaseAdapter,
    Attachment,
    DataChange,
    DEFAULT_QUERY_OPTIONS,
    QueryOptions
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
    onSynced?: (version: number) => void;  // 修改：接收同步后的版本号
}

// Synchronization status information
export interface ClientStatus {
    currentVersion: number;     // Current data version number
    pendingChanges: number;     // Number of pending changes to be synchronized
    cloudConfigured: boolean;   // Whether cloud is configured
    syncStatus: SyncStatus;     // Current synchronization status
}


// Sync client, providing a simple and easy-to-use API to manage local data and synchronization operations
export class SyncClient {
    private localAdapter: DatabaseAdapter;
    private localCoordinator: LocalCoordinator;
    private cloudCoordinator?: CloudCoordinator;
    private syncManager?: SyncManager;
    private config: SyncConfig;
    public clientStatus: ClientStatus;
    private currentSyncStatus: SyncStatus = SyncStatus.Idle;
    private onStatusCallback?: (status: SyncStatus) => void;
    private onDataPullCallback?: (changes: DataChange[]) => void;
    private onSyncedCallback?: (version: number) => void;

    // Create sync client
    constructor(options: SyncClientOptions) {
        this.localAdapter = options.localAdapter;
        this.localCoordinator = new LocalCoordinator(
            this.localAdapter,
            options.encryptionConfig
        );
        this.clientStatus = {
            currentVersion: 0,
            pendingChanges: 0,
            cloudConfigured: false,
            syncStatus: SyncStatus.Idle
        };
        this.onStatusCallback = options.onStatus;
        this.onDataPullCallback = options.onDataPull;
        this.config = getSyncConfig(options.syncConfig);
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


    setSyncedCallback(callback: (version: number) => void): void {
        this.onSyncedCallback = callback;
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
            this.syncManager = new SyncManager(
                this.localCoordinator,
                this.cloudCoordinator
            );
            this.updateSyncStatus(SyncStatus.Idle);
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
            this.updateSyncStatus(SyncStatus.Idle);
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            console.error("Local storage initialization failed:", error);
            throw error;
        }
    }


    // Query data
    async query<T extends BaseModel>(storeName: string, options?: QueryOptions): Promise<T[]> {
        try {
            const result = await this.localAdapter.readByVersion<T>(
                storeName,
                options || DEFAULT_QUERY_OPTIONS
            );
            return result.items;
        } catch (error) {
            throw new Error
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


    // readSingleFile
    async readFile(fileId: string): Promise<Blob | ArrayBuffer | null> {
        if (!fileId) {
            throw new Error('File ID is required');
        }
        try {
            const filesMap = await this.localCoordinator.localAdapter.readFiles([fileId]);
            return filesMap.get(fileId) || null;
        } catch (error) {
            console.error(`Error reading file ${fileId}:`, error);
            throw error;
        }
    }



    // Attach file to specified model
    async attach(
        storeId: string,
        modelId: string,
        file: File | Blob | ArrayBuffer,
        filename: string,
        mimeType: string,
        metadata: any = {}
    ): Promise<Attachment> {
        if (!storeId) {
            throw new Error('Store name is required');
        }
        if (!modelId) {
            throw new Error('Model ID is required');
        }
        return this.localCoordinator.attachFile(
            modelId,
            storeId,
            file,
            filename,
            mimeType,
            metadata
        );
    }


    // Detach file from specified model
    async detach(
        storeName: string,
        modelId: string,
        attachmentId: string
    ): Promise<BaseModel> {
        if (!storeName) {
            throw new Error('Store name is required');
        }
        if (!modelId) {
            throw new Error('Model ID is required');
        }
        if (!attachmentId) {
            throw new Error('Attachment ID is required');
        }
        return this.localCoordinator.detachFile(storeName, modelId, attachmentId);
    }



    async sync(): Promise<boolean> {
        if (!this.syncManager) {
            console.error("云同步源未配置，请先调用 setCloudAdapter");
            return false;
        }
        try {
            // 记录初始状态
            this.updateSyncStatus(SyncStatus.Downloading);
            const pullSuccess = await this.pull();
            if (!pullSuccess) {
                console.error("同步操作中拉取云端数据失败");
                return false;
            }
            // 2. 再将本地更改推送到云端
            this.updateSyncStatus(SyncStatus.Uploading);
            const pushSuccess = await this.push();
            // 3. 根据结果更新状态
            this.updateSyncStatus(pushSuccess ? SyncStatus.Idle : SyncStatus.Error);
            // 4. 返回综合结果
            return pushSuccess;
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            console.error("同步操作失败:", error);
            return false;
        }
    }


    // Only push local changes to cloud
    async push(): Promise<boolean> {
        if (!this.syncManager) {
            console.error("Cloud sync source not configured, please call setCloudAdapter first");
            return false;
        }
        try {
            this.updateSyncStatus(SyncStatus.Uploading);
            const success = await this.syncManager.pushChanges(this.config.batchSize);
            if (success && this.onSyncedCallback) {
                const currentVersion = await this.localCoordinator.getCurrentVersion();
                this.onSyncedCallback(currentVersion);
            }
            this.updateSyncStatus(success ? SyncStatus.Idle : SyncStatus.Error);
            return success;
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            console.error("Push operation failed:", error);
            return false;
        }
    }


    // Only pull changes from cloud
    async pull(): Promise<boolean> {
        if (!this.syncManager) {
            console.error("Cloud sync source not configured, please call setCloudAdapter first");
            return false;
        }
        try {
            this.updateSyncStatus(SyncStatus.Downloading);
            const result = await this.syncManager.pullChanges();
            if (result.success && this.onSyncedCallback && result.version) {
                this.onSyncedCallback(result.version);
            }
            if (result.success && this.onDataPullCallback && result.changes) {
                this.onDataPullCallback(result.changes);
            }
            this.updateSyncStatus(result.success ? SyncStatus.Idle : SyncStatus.Error);
            return result.success;
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            console.error("Pull operation failed:", error);
            return false;
        }
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
    ): Promise<void> {
        try {
            this.updateSyncStatus(SyncStatus.Maintaining);
            this.updateSyncStatus(SyncStatus.Idle);
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            throw error;
        }
    }


}
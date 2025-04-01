// core/SyncEngine.ts
// Provides a simple and easy-to-use synchronization client API, encapsulating internal synchronization complexity

import {
    DeltaModel,
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



// Synchronization status enumeration
export enum SyncStatus {
    Error = -2,        // Error status
    Offline = -1,      // Offline status
    Idle = 0,          // Idle status
    Uploading = 1,     // Upload synchronization in progress
    Downloading = 2,   // Download synchronization in progress
    Operating = 3,     // Operation in progress (clearing notes and other special operations)
}


// Sync client initialization options
export interface SyncEngineInitOptions {
    localAdapter: DatabaseAdapter;
    encryptionConfig?: EncryptionConfig;
    syncOption?: SyncOptions;  // 将其他选项移到这个对象中
}



// Sync client options
export interface SyncOptions {
    autoSync?: {
        enabled?: boolean;
        interval?: number;
        retryDelay?: number;
    };
    onStatusUpdate?: (status: SyncStatus) => void;
    onVersionUpdate?: (version: number) => void;
    onChangePulled?: (changes: DataChange[]) => void;
    onChangePushed?: (changes: DataChange[]) => void;
    encryption?: EncryptionConfig;    // 端到端的加密配置
    maxRetries?: number;    // 最大重试次数
    timeout?: number;       // 超时时间(毫秒)
    maxFileSize?: number;   // 最大支持的文件大小(字节)
    batchSize?: number;     // 同步批次的数量
    payloadSize?: number;   // 传输的对象最大大小(字节)
    fileChunkSize?: number; // 文件分块存储的单块大小(字节)
}



// Sync client, providing a simple and easy-to-use API to manage local data and synchronization operations
export class SyncEngine {
    private localAdapter: DatabaseAdapter;
    private localCoordinator: LocalCoordinator;
    private cloudCoordinator?: CloudCoordinator;
    private syncManager?: SyncManager;
    private syncOptions: SyncOptions = {
        autoSync: {
            enabled: false,
            interval: 30000,
            retryDelay: 5000
        },
        onStatusUpdate: undefined,
        onVersionUpdate: undefined,
        onChangePulled: undefined,
        onChangePushed: undefined,
        encryption: undefined,
        maxRetries: 3,
        timeout: 10000,
        maxFileSize: 10000000,
        batchSize: 100,
        payloadSize: 100000,
        fileChunkSize: 1000000       // 1MB
    };
    private autoSyncTimer?: NodeJS.Timeout;
    private syncStatus: SyncStatus = SyncStatus.Offline;
    private currentVersion: number = 0;
    private cloudConfigured: boolean = false;



    // Create sync client
    constructor(options: SyncEngineInitOptions) {
        this.localAdapter = options.localAdapter;
        this.localCoordinator = new LocalCoordinator(
            this.localAdapter,
            options.encryptionConfig
        );
        if (options.syncOption) {
            this.updateSyncOptions(options.syncOption);
        }
        this.initialize();
    }


    // Initialize local coordinator
    private async initialize(): Promise<void> {
        try {
            this.updateSyncStatus(SyncStatus.Operating);
            const version = await this.localCoordinator.getCurrentVersion();
            this.currentVersion = version;
            this.updateSyncStatus(SyncStatus.Idle);
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            console.error("Local storage initialization failed:", error);
            throw error;
        }
    }


    // enableAutoSync
    public enableAutoSync(interval?: number): void {
        if (interval) {
            this.syncOptions.autoSync!.interval = interval;
        }
        if (this.syncOptions.autoSync?.enabled) {
            return;
        }
        this.syncOptions.autoSync!.enabled = true;
        this.scheduleNextSync();
        console.log(`自动同步已启用，间隔: ${this.syncOptions.autoSync?.interval}ms`);
    }


    // disableAutoSync
    public disableAutoSync(): void {
        if (this.syncOptions.autoSync) {
            this.syncOptions.autoSync.enabled = false;
        }
        if (this.autoSyncTimer) {
            clearTimeout(this.autoSyncTimer);
            this.autoSyncTimer = undefined;
        }
        console.log('自动同步已禁用');
    }


    // scheduleNextSync
    private async scheduleNextSync(): Promise<void> {
        if (!this.syncOptions.autoSync?.enabled) {
            return;
        }
        try {
            const syncResult = await this.sync();
            if (syncResult) {
                this.autoSyncTimer = setTimeout(
                    () => this.scheduleNextSync(),
                    this.syncOptions.autoSync!.interval
                );
            } else {
                this.autoSyncTimer = setTimeout(
                    () => this.scheduleNextSync(),
                    this.syncOptions.autoSync!.retryDelay
                );
            }
        } catch (error) {
            console.error('自动同步执行失败:', error);
            this.autoSyncTimer = setTimeout(
                () => this.scheduleNextSync(),
                this.syncOptions.autoSync!.retryDelay
            );
        }
    }


    // Update synchronization options
    public updateSyncOptions(options: Partial<SyncOptions>): void {
        this.syncOptions = {
            ...this.syncOptions,
            ...options,
            autoSync: options.autoSync ? {
                ...this.syncOptions.autoSync,
                ...options.autoSync
            } : this.syncOptions.autoSync
        };
        if (this.syncOptions.autoSync?.enabled) {
            this.enableAutoSync();
        } else if (options.autoSync?.enabled === false) {
            this.disableAutoSync();
        }
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
            this.cloudConfigured = true;
            this.updateSyncStatus(SyncStatus.Idle);
        } catch (error) {
            this.cloudConfigured = false;
            this.updateSyncStatus(SyncStatus.Error);
            console.error("Cloud adapter initialization failed:", error);
            this.cloudCoordinator = undefined;
            throw error;
        }
    }


    private updateSyncStatus(status: SyncStatus): void {
        this.syncStatus = status;
        if (this.syncOptions.onStatusUpdate) {
            this.syncOptions.onStatusUpdate(status);
        }
    }


    // Query data
    async query<T extends DeltaModel>(storeName: string, options?: QueryOptions): Promise<T[]> {
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
    async save<T extends DeltaModel>(storeName: string, data: T | T[]): Promise<T[]> {
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
    ): Promise<DeltaModel> {
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
            this.updateSyncStatus(SyncStatus.Downloading);
            const pullSuccess = await this.pull();
            if (!pullSuccess) {
                console.error("同步操作中拉取云端数据失败");
                return false;
            }
            this.updateSyncStatus(SyncStatus.Uploading);
            const pushSuccess = await this.push();
            this.updateSyncStatus(pushSuccess ? SyncStatus.Idle : SyncStatus.Error);
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
            const result = await this.syncManager.pushChanges();
            if (result.success) {
                if (result.version) {
                    this.currentVersion = result.version;
                    if (this.syncOptions.onVersionUpdate) {
                        this.syncOptions.onVersionUpdate(result.version);
                    }
                }
                if (this.syncOptions.onChangePushed && result.changes) {
                    this.syncOptions.onChangePushed(result.changes);
                }
            }
            this.updateSyncStatus(result.success ? SyncStatus.Idle : SyncStatus.Error);
            return result.success;
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
            if (result.success) {
                if (result.version) {
                    this.currentVersion = result.version;
                    if (this.syncOptions.onVersionUpdate) {
                        this.syncOptions.onVersionUpdate(result.version);
                    }
                }
                if (this.syncOptions.onChangePulled && result.changes) {
                    this.syncOptions.onChangePulled(result.changes);
                }
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

    // Access underlying cloud coordination layer
    getSyncOptions(): SyncOptions {
        return { ...this.syncOptions };
    }


    dispose(): void {
        this.disableAutoSync();
    }

    // Disconnect cloud connection, return to local mode
    public disconnectCloud(): void {
        this.cloudCoordinator = undefined;
        this.syncManager = undefined;
        this.updateSyncStatus(SyncStatus.Offline);
        console.log("Cloud connection disconnected, now in local mode");
    }

}
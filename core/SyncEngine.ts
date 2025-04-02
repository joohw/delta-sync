// core/SyncEngine.ts

import {
    ISyncEngine,
    DatabaseAdapter,
    SyncOptions,
    DataChange,
    SyncView,
    SyncStatus,
    Attachment,
    FileItem
} from './types';
import { LocalCoordinator } from './LocalCoordinator'
import { CloudCoordinator } from './CloudCoordinator'

export class SyncEngine implements ISyncEngine {
    private localCoordinator: LocalCoordinator;
    private cloudCoordinator?: CloudCoordinator;
    private options: SyncOptions;
    private autoSyncTimer?: ReturnType<typeof setInterval>;
    private syncStatus: SyncStatus = SyncStatus.IDLE;
    private isInitialized: boolean = false;


    constructor(
        localAdapter: DatabaseAdapter,
        options: SyncOptions = {}
    ) {
        this.localCoordinator = new LocalCoordinator(localAdapter);
        this.options = this.mergeDefaultOptions(options);
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
        this.cloudCoordinator = new CloudCoordinator(cloudAdapter);
    }


    // 数据操作方法
    async save<T extends Record<string, any>>(
        storeName: string,
        data: T | T[],
        id?: string | string[]
    ): Promise<T[]> {
        await this.ensureInitialized();
        const items = Array.isArray(data) ? data : [data];
        const ids = Array.isArray(id) ? id : id ? [id] : [];
        // 准备要保存的数据
        const deltaItems = items.map((item, index) => ({
            ...item,
            id: ids[index] || this.generateId(),
            store: storeName
        }));
        // 保存到本地
        const savedItems = await this.localCoordinator.putBulk(storeName, deltaItems);
        // 返回原始数据类型，移除内部使用的元数据字段
        return savedItems.map(item => {
            const { store, version, deleted, ...userData } = item;
            return userData as T;
        });
    }


    async delete(storeName: string, ids: string | string[]): Promise<void> {
        await this.ensureInitialized();
        const idsToDelete = Array.isArray(ids) ? ids : [ids];
        await this.localCoordinator.deleteBulk(storeName, idsToDelete);
    }



    async saveFile(
        fileId: string,
        file: File | Blob | ArrayBuffer,
        filename: string,
        mimeType: string,
        metadata: Record<string, any> = {}
    ): Promise<Attachment> {
        await this.ensureInitialized();
        try {
            // 验证文件大小
            const fileSize = file instanceof ArrayBuffer ? file.byteLength : file.size;
            if (fileSize > this.options.maxFileSize!) {
                throw new Error(`File size exceeds limit of ${this.options.maxFileSize} bytes`);
            }
            // 准备文件项
            const fileItem: FileItem = {
                fileId,
                content: file
            };
            // 上传文件
            const [attachment] = await this.localCoordinator.uploadFiles([fileItem]);
            // 更新附件信息
            const updatedAttachment: Attachment = {
                ...attachment,
                filename,
                mimeType,
                metadata,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                size: fileSize
            };
            return updatedAttachment;
        } catch (error) {
            console.error('Failed to save file:', error);
            throw error;
        }
    }



    async readFile(fileId: string): Promise<Blob | ArrayBuffer | null> {
        await this.ensureInitialized();
        try {
            const files = await this.localCoordinator.downloadFiles([fileId]);
            return files.get(fileId) || null;
        } catch (error) {
            console.error('Failed to read file:', error);
            throw error;
        }
    }


    // 同步操作方法
    async sync(): Promise<boolean> {
        if (this.syncStatus !== SyncStatus.IDLE) {
            console.warn('Sync already in progress, current status:', this.syncStatus);
            return false;
        }
        if (!this.cloudCoordinator) {
            console.warn('Cloud adapter not set');
            this.updateStatus(SyncStatus.OFFLINE);
            return false;
        }
        try {
            // Download phase
            this.updateStatus(SyncStatus.DOWNLOADING);
            const pullSuccess = await this.pull();
            if (!pullSuccess) {
                throw new Error('Pull operation failed');
            }
            // Upload phase
            this.updateStatus(SyncStatus.UPLOADING);
            const pushSuccess = await this.push();
            if (!pushSuccess) {
                throw new Error('Push operation failed');
            }
            this.updateStatus(SyncStatus.IDLE);
            return true;
        } catch (error) {
            console.error('Sync failed:', error);
            this.updateStatus(SyncStatus.ERROR);
            return false;
        }
    }


    async push(): Promise<boolean> {
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            throw new Error('Cloud adapter not set');
        }
        try {
            this.updateStatus(SyncStatus.UPLOADING);
            // Get views
            const localView = await this.localCoordinator.getCurrentView();
            const cloudView = await this.cloudCoordinator.getCurrentView();
            // Calculate differences
            const { toUpload } = SyncView.diffViews(localView, cloudView);
            if (toUpload.length === 0) {
                this.updateStatus(SyncStatus.IDLE);
                return true;
            }
            // Process in batches
            const batches = this.splitIntoBatches(toUpload, this.options.batchSize!);
            for (const batch of batches) {
                // Read complete data
                const items = await this.localCoordinator.readBulk(
                    batch[0].store,
                    batch.map(item => item.id)
                );
                // Upload changes
                await this.cloudCoordinator.applyChanges(items.map(item => ({
                    id: item.id,
                    store: item.store,
                    version: item.version,
                    operation: item.deleted ? 'delete' : 'put',
                    data: item.data
                })));
            }

            // Report progress if callback provided
            this.options.onChangePushed?.(
                toUpload.map(item => ({
                    id: item.id,
                    store: item.store,
                    version: item.version,
                    operation: item.deleted ? 'delete' : 'put',
                    data: null
                }))
            );
            this.updateStatus(SyncStatus.IDLE);
            return true;
        } catch (error) {
            console.error('Push failed:', error);
            this.updateStatus(SyncStatus.ERROR);
            return false;
        }
    }



    async pull(): Promise<boolean> {
        if (!this.cloudCoordinator) {
            this.updateStatus(SyncStatus.OFFLINE);
            throw new Error('Cloud adapter not set');
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
                return true;
            }
            // Download and process in batches
            const batches = this.splitIntoBatches(toDownload, this.options.batchSize!);
            const downloadedChanges: DataChange[] = [];
            for (const batch of batches) {
                // Read from cloud
                const items = await this.cloudCoordinator.readBulk(
                    batch[0].store,
                    batch.map(item => item.id)
                );
                // Save to local
                for (const item of items) {
                    await this.localCoordinator.putBulk(item.store, [item]);
                    downloadedChanges.push({
                        id: item.id,
                        store: item.store,
                        version: item.version,
                        operation: item.deleted ? 'delete' : 'put',
                        data: item.data
                    });
                }
            }
            // Report progress if callback provided
            this.options.onChangePulled?.(downloadedChanges);
            this.updateStatus(SyncStatus.IDLE);
            return true;
        } catch (error) {
            console.error('Pull failed:', error);
            this.updateStatus(SyncStatus.ERROR);
            return false;
        }
    }


    // 自动同步控制
    enableAutoSync(interval?: number): void {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
        }
        const syncInterval = interval || this.options.autoSync?.interval || 5000;
        this.autoSyncTimer = setInterval(async () => {
            await this.sync();
        }, syncInterval);
    }

    disableAutoSync(): void {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = undefined;
        }
    }

    // 配置更新
    updateSyncOptions(options: Partial<SyncOptions>): void {
        this.options = this.mergeDefaultOptions({
            ...this.options,
            ...options
        });
        // 如果更新了自动同步设置，重新配置自动同步
        if (options.autoSync) {
            if (options.autoSync.enabled) {
                this.enableAutoSync(options.autoSync.interval);
            } else {
                this.disableAutoSync();
            }
        }
    }

    // 实例获取
    async getlocalCoordinator(): Promise<LocalCoordinator> {
        return this.localCoordinator;
    }

    async getlocalAdapter(): Promise<DatabaseAdapter> {
        return await this.localCoordinator.getAdapter();
    }

    // 清理方法
    dispose(): void {
        this.disableAutoSync();
        this.syncStatus = SyncStatus.OFFLINE;
    }

    disconnectCloud(): void {
        this.cloudCoordinator = undefined;
    }


    // 私有辅助方法
    private updateStatus(status: SyncStatus): void {
        if (this.syncStatus === status) return;
        this.syncStatus = status;
        this.options.onStatusUpdate?.(status);
        // Log status changes in development
        if (process.env.NODE_ENV !== 'production') {
            console.log('Sync status changed to:', SyncStatus[status]);
        }
    }

    private generateId(): string {
        return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
        const batches: T[][] = [];
        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }
        return batches;
    }

}

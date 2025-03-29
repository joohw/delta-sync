// core/SyncClient.ts
// 提供简单易用的同步客户端API，封装内部同步复杂性

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

// 同步状态枚举
export enum SyncStatus {
    Error = -2,        // 错误或离线状态
    Offline = -1,      // 错误或离线状态
    Idle = 0,          // 空闲状态
    Uploading = 1,     // 上传同步中
    Downloading = 2,   // 下载同步中
    Operating = 3,     // 操作中(清空笔记等特殊操作)
    Maintaining = 4,   // 维护中(清理旧数据，优化存储)
}

// 同步客户端选项
export interface SyncClientOptions {
    localAdapter: DatabaseAdapter;
    encryptionConfig?: EncryptionConfig;
    syncConfig?: Partial<SyncConfig>;  // 新增：同步配置
    onStatus?: (status: SyncStatus) => void;  // 状态变化回调
    onDataPull?: (changes: DataChange[]) => void;  // 数据拉取回调
}

// 同步状态信息
export interface ClientStatus {
    currentVersion: number;     // 当前数据版本号
    pendingChanges: number;     // 待同步的变更数量
    cloudConfigured: boolean;   // 是否已配置云端
    syncStatus: SyncStatus;     // 当前同步状态
}

// 查询选项
export interface QueryOptions {
    ids?: string[];    // 要查询的特定ID
    limit?: number;    // 查询结果限制
    offset?: number;   // 查询结果偏移量
    since?: number;    // 查询版本号范围（大于该版本号）
}

// 同步客户端，提供简单易用的API来管理本地数据和同步操作
export class SyncClient {
    private localAdapter: DatabaseAdapter;
    private localCoordinator: LocalCoordinator;
    private cloudCoordinator?: CloudCoordinator;
    private syncManager?: SyncManager;
    private config: SyncConfig;
    private currentSyncStatus: SyncStatus = SyncStatus.Idle;
    private onStatusCallback?: (status: SyncStatus) => void;
    private onDataPullCallback?: (changes: DataChange[]) => void;

    // 创建同步客户端
    constructor(options: SyncClientOptions) {
        this.localAdapter = options.localAdapter;
        this.localCoordinator = new LocalCoordinator(
            this.localAdapter,
            options.encryptionConfig
        );
        this.onStatusCallback = options.onStatus;
        this.onDataPullCallback = options.onDataPull;
        // 初始化同步配置
        this.config = getSyncConfig(options.syncConfig);
        // 自动初始化本地协调器
        this.initialize();
    }

    // 设置状态变化回调
    setStatusCallback(callback: (status: SyncStatus) => void): void {
        this.onStatusCallback = callback;
    }

    // 设置数据拉取回调
    setDataPullCallback(callback: (changes: DataChange[]) => void): void {
        this.onDataPullCallback = callback;
    }

    // 更新同步配置
    updateSyncConfig(config: Partial<SyncConfig>): void {
        this.config = {
            ...this.config,
            ...config
        };
        console.log("同步配置已更新:", this.config);
    }

    // 获取当前同步配置
    getSyncConfig(): SyncConfig {
        return { ...this.config };
    }

    // 设置云端适配器，启用同步功能
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
            console.log("云端适配器已连接，同步就绪");
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            console.error("云端适配器初始化失败:", error);
            this.cloudCoordinator = undefined;
            throw error;
        }
    }

    // 断开云端连接，回到本地模式
    disconnectCloud(): void {
        this.cloudCoordinator = undefined;
        this.syncManager = undefined;
        this.updateSyncStatus(SyncStatus.Offline);
        console.log("已断开云端连接，现在处于本地模式");
    }

    // 获取当前同步状态枚举值
    getCurrentSyncStatus(): SyncStatus {
        return this.currentSyncStatus;
    }

    // 更新同步状态并触发回调
    private updateSyncStatus(status: SyncStatus): void {
        this.currentSyncStatus = status;
        if (this.onStatusCallback) {
            this.onStatusCallback(status);
        }
    }

    // 初始化本地协调器
    private async initialize(): Promise<void> {
        try {
            this.updateSyncStatus(SyncStatus.Operating);
            await this.localCoordinator.initialize();
            this.updateSyncStatus(SyncStatus.Idle);
            console.log("本地存储初始化成功");
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            console.error("本地存储初始化失败:", error);
            throw error;
        }
    }

    // 查询数据
    async query<T extends BaseModel>(storeName: string, options?: QueryOptions): Promise<T[]> {
        if (options?.ids && options.ids.length > 0) {
            return await this.localAdapter.readBulk<T>(storeName, options.ids);
        } else {
            const result = await this.localAdapter.read<T>(storeName, {
                limit: options?.limit,
                offset: options?.offset,
                since: options?.since // 现在表示版本号大于该值
            });
            return result.items;
        }
    }

    // 保存数据到指定存储
    async save<T extends BaseModel>(storeName: string, data: T | T[]): Promise<T[]> {
        const items = Array.isArray(data) ? data : [data];
        return await this.localCoordinator.putBulk(storeName, items);
    }

    // 从指定存储删除数据
    async delete(storeName: string, ids: string | string[]): Promise<void> {
        const itemIds = Array.isArray(ids) ? ids : [ids];
        await this.localCoordinator.deleteBulk(storeName, itemIds);
    }

    // 执行双向同步操作
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

    // 仅推送本地变更到云端
    async push(): Promise<SyncResponse> {
        if (!this.syncManager) {
            return {
                success: false,
                error: "未配置云端同步源，请先调用 setCloudAdapter"
            };
        }
        try {
            this.currentSyncStatus = SyncStatus.Uploading;
            // 使用配置中的批处理大小
            const result = await this.syncManager.pushChanges(this.config.batchSize);
            this.currentSyncStatus = result.success ? SyncStatus.Idle : SyncStatus.Error;
            return result;
        } catch (error) {
            this.currentSyncStatus = SyncStatus.Error;
            throw error;
        }
    }

    // 仅从云端拉取变更
    async pull(): Promise<SyncResponse> {
        if (!this.syncManager) {
            return {
                success: false,
                error: "未配置云端同步源，请先调用 setCloudAdapter"
            };
        }
        try {
            this.updateSyncStatus(SyncStatus.Downloading);
            const result = await this.syncManager.pullChanges();
            this.updateSyncStatus(result.success ? SyncStatus.Idle : SyncStatus.Error);
            // 如果拉取成功且有数据拉取回调和变更数据，通知新数据
            if (result.success && this.onDataPullCallback && result.changes && result.changes.length > 0) {
                this.onDataPullCallback(result.changes);
            }
            return result;
        } catch (error) {
            this.updateSyncStatus(SyncStatus.Error);
            throw error;
        }
    }


    // 获取当前同步状态
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


    // 保存文件附件
    async saveFiles(files: FileItem[]): Promise<Attachment[]> {
        return await this.localAdapter.saveFiles(files);
    }


    // 读取文件附件
    async readFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>> {
        return await this.localAdapter.readFiles(fileIds);
    }

    // 删除文件附件
    async deleteFiles(fileIds: string[]): Promise<{ deleted: string[], failed: string[] }> {
        return await this.localAdapter.deleteFiles(fileIds);
    }


    // 访问底层的协调层
    getlocalCoordinator(): LocalCoordinator {
        return this.localCoordinator;
    }

    // 访问底层的本地存储适配器
    getlocalAdapter(): DatabaseAdapter {
        return this.localAdapter;
    }

    testLocalAdapter(): void {
        testAdapterFunctionality(this.localAdapter, "local_adapater_test");
    }

    // 执行维护操作，清理旧数据
    async maintenance(
        cloudOlderThan: number = 30 * 24 * 60 * 60 * 1000
    ): Promise<void> {
        try {
            this.updateSyncStatus(SyncStatus.Maintaining);
            // 本地维护
            await this.localCoordinator.performMaintenance();
            // 云端维护（如果已配置）
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
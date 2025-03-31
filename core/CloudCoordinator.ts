// CloudCoordinator.ts
// 云端的协调层

import {
    DatabaseAdapter,
    SyncResponse,
    DataChange,
    AttachmentChange
} from './types';


export class CloudCoordinator {
    public cloudAdapter: DatabaseAdapter;
    public readonly CHANGES_STORE = 'cloud_synced_changes'; // 所有变更的存储
    public readonly ATTACHMENT_CHANGES_STORE = 'cloud_attachment_changes'; // 新增附件变更表


    constructor(cloudAdapter: DatabaseAdapter) {
        this.cloudAdapter = cloudAdapter;
    }


    // 处理来自客户端的同步请求
    async applyChanges(changes: DataChange[]): Promise<SyncResponse> {
        try {
            // 应用变更
            await this.cloudAdapter.putBulk(this.CHANGES_STORE, changes);
            // 获取最新版本号
            const latestVersion = await this.getLatestVersion();
            return {
                success: true,
                processed: changes.length,
                version: latestVersion  // 使用实际的最新版本号
            };
        } catch (error: unknown) {
            console.error('处理同步请求时出错:', error);
            return {
                success: false,
                error: this.getErrorMessage(error)
            };
        }
    }


    async applyAttachmentChanges(changes: AttachmentChange[]): Promise<SyncResponse> {
        try {
            await this.cloudAdapter.putBulk(this.ATTACHMENT_CHANGES_STORE, changes);
            const latestVersion = await this.getLatestVersion();
            return {
                success: true,
                processed: changes.length,
                version: latestVersion,  // 使用实际的最新版本号
                info: {
                    attachments_processed: changes.length
                }
            };
        } catch (error) {
            return {
                success: false,
                error: this.getErrorMessage(error)
            };
        }
    }


    async getAttachmentChanges(since: number): Promise<AttachmentChange[]> {
        const result = await this.cloudAdapter.readByVersion<AttachmentChange>(
            this.ATTACHMENT_CHANGES_STORE,
            { since }
        );
        return result.items;
    }


    // 处理来自客户端的拉取请求（使用 since 参数表示最小版本号）
    async getPendingChanges(since: number): Promise<SyncResponse> {
        try {
            const result = await this.cloudAdapter.readByVersion<DataChange>(
                this.CHANGES_STORE, 
                { since }
            );
            console.log("从云端读取更新成功",result)
            const latestVersion = await this.getLatestVersion();
            return {
                success: true,
                changes: result.items,
                version: latestVersion,
            };
        } catch (error: unknown) {
            console.error('获取变更失败:', error);
            return {
                success: false,
                error: this.getErrorMessage(error)
            };
        }
    }


    // 辅助方法，在结果中附加详细错误
    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        } else if (typeof error === 'string') {
            return error;
        } else if (error && typeof error === 'object' && 'message' in error) {
            return String((error as { message: unknown }).message);
        }
        return '未知错误';
    }



    // 获取最新变更的版本号(优化查询方式)
    async getLatestVersion(): Promise<number> {
        try {
            const result = await this.cloudAdapter.readByVersion<DataChange>(
                this.CHANGES_STORE,
                {
                    limit: 1,
                    order: 'desc' // 直接使用倒序排列
                }
            );
            if (result.items.length > 0 && result.items[0]._version !== undefined) {
                return result.items[0]._version;
            }
            return 0;
        } catch (error) {
            console.error('获取最新版本号失败:', error);
            return 0;
        }
    }


}
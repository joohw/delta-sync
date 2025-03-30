// CloudCoordinator.ts
// 云端的协调层

import {
    DatabaseAdapter,
    SyncResponse,
    DataChange,
    Attachment,
    AttachmentChange
} from './types';


export class CloudCoordinator {
    public cloudAdapter: DatabaseAdapter;
    public readonly CHANGES_STORE = 'cloud_synced_changes'; // 所有变更的存储


    constructor(cloudAdapter: DatabaseAdapter) {
        this.cloudAdapter = cloudAdapter;
    }


    // 初始化
    async initialize(): Promise<void> {
        await this.cloudAdapter.initSync();
    }



    // 处理来自客户端的同步请求
    async processPushRequest(changes: DataChange[]): Promise<SyncResponse> {
        try {
            // 获取云端当前最新版本号
            console.log('处理同步请求...', changes);
            const latestVersion = await this.getLatestVersion();
            // 找出提交的变更中最大和最小的版本号
            let maxVersion = 0;
            let minVersion = Number.MAX_SAFE_INTEGER;
            const versionCounts = new Map<number, number>(); // 用于统计每个版本的变更数量
            for (const change of changes) {
                if (change._version > maxVersion) {
                    maxVersion = change._version;
                }
                if (change._version < minVersion) {
                    minVersion = change._version;
                }
                // 统计每个版本的变更数量
                const count = versionCounts.get(change._version) || 0;
                versionCounts.set(change._version, count + 1);
            }
            await this.cloudAdapter.putBulk(this.CHANGES_STORE, changes);
            console.log(`推送请求详情:
                        - 云端原始版本: ${latestVersion}
                        - 推送变更数量: ${changes.length}
                        - 变更版本范围: ${minVersion} 到 ${maxVersion}
                        - 云端更新后版本: ${maxVersion}`);
            return {
                success: true,
                processed: changes.length,
                version: maxVersion
            };
        } catch (error: unknown) {
            console.error('处理同步请求时出错:', error);
            return {
                success: false,
                error: this.getErrorMessage(error)
            };
        }
    }



    // 处理来自客户端的拉取请求（使用 since 参数表示最小版本号）
    async processPullRequest(lastSyncVersion: number): Promise<SyncResponse> {
        try {
            // 获取云端当前最新版本号
            const latestVersion = await this.getLatestVersion();
            const result = await this.cloudAdapter.readByVersion<DataChange>(this.CHANGES_STORE, {
                since: lastSyncVersion // 表示版本号大于 lastSyncVersion
            });
            // 计算返回变更中的最大版本号
            let maxChangeVersion = lastSyncVersion;
            for (const change of result.items) {
                if (change._version > maxChangeVersion) {
                    maxChangeVersion = change._version;
                }
            }
            console.log(`拉取请求详情:
                        - 客户端请求版本: ${lastSyncVersion}
                        - 云端最新版本: ${latestVersion}
                        - 返回变更数量: ${result.items.length}
                        - 返回变更版本范围: ${result.items.length > 0 ? `${Math.min(...result.items.map(c => c._version))} 到 ${maxChangeVersion}` : '无变更'}`);
            return {
                success: true,
                changes: result.items,
                version: maxChangeVersion, // 返回最大版本号
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



    // 获取最新变更的版本号(Todo: 优化查询方式)
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
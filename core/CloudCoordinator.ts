// CloudCoordinator.ts
// 云端的协调层

import {
    DatabaseAdapter,
    SyncResponse,
    DataChange,
    Attachment, FileItem
} from './types';


export class CloudCoordinator {
    public cloudAdapter: DatabaseAdapter;
    public readonly CHANGES_STORE = 'cloud_synced_changes'; // 所有变更的存储
    private readonly META_STORE = 'cloud_synced_meta'; // 元数据存储
    private readonly VERSION_KEY = 'current_version'; // 最新变更的版本号


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
            const latestVersionResponse = await this.getLatestVersion();
            const cloudLatestVersion = latestVersionResponse.version || 0;
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
            // 记录创建时间（用于维护目的，但不再作为同步主要依据）
            const serverTimestamp = Date.now();
            const changeRecords = changes.map(change => {
                return {
                    ...change,
                    _created_at: serverTimestamp
                };
            });
            await this.cloudAdapter.putBulk(this.CHANGES_STORE, changeRecords);
            await this.updateLatestVersion(maxVersion);
            console.log(`推送请求详情:
                        - 云端原始版本: ${cloudLatestVersion}
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
            const result = await this.cloudAdapter.read<DataChange>(this.CHANGES_STORE, {
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
        - 云端最新版本: ${latestVersion.version || 0}
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



    // 清理旧的数据
    async performMaintenance(olderThan: number = 30 * 24 * 60 * 60 * 1000): Promise<void> {
        const now = Date.now();
        let offset = 0;
        let hasMore = true;
        const batchSize = 1000;
        while (hasMore) {
            const changesResult = await this.cloudAdapter.read<any>(this.CHANGES_STORE, {
                offset: offset,
                limit: batchSize
            });
            const changes = changesResult.items;
            hasMore = changesResult.hasMore;
            const oldChanges = changes.filter(
                change => (now - change.server_timestamp) > olderThan
            );
            if (oldChanges.length > 0) {
                await this.cloudAdapter.deleteBulk(
                    this.CHANGES_STORE,
                    oldChanges.map(change => change._delta_id)
                );
            }
            if (changes.length < batchSize) {
                hasMore = false;
            } else {
                offset += changes.length;
            }
        }
    }



    // 处理附件更改,返回需要上传的附件列表，由syncManager处理上传
    async processAttachmentChanges(change: DataChange): Promise<{
        attachmentsToUpload: string[],  // 需要上传到云端的附件ID
        deletedAttachments: string[],   // 已经删除的附件
        unchangedAttachments: string[]  // 无需处理的附件ID
    }> {
        const result = {
            deletedAttachments: [] as string[],
            attachmentsToUpload: [] as string[],
            unchangedAttachments: [] as string[]
        };
        try {
            // 从变更存储中查找之前的版本
            const existingRecords = await this.cloudAdapter.readBulk<DataChange>(
                this.CHANGES_STORE,
                [change._delta_id]
            );
            // 如果是删除操作
            if (change.type === 'delete') {
                if (existingRecords.length > 0) {
                    const existingRecord = existingRecords[0];
                    if (existingRecord?.data?._attachments) {
                        // 收集需要删除的附件ID
                        const attachmentIdsToDelete = (existingRecord.data._attachments as Attachment[])
                            .filter(att => att.id)
                            .map(att => att.id);

                        if (attachmentIdsToDelete.length > 0) {
                            // 批量删除附件
                            const deleteResult = await this.cloudAdapter.deleteFiles(attachmentIdsToDelete);
                            result.deletedAttachments = deleteResult.deleted;

                            // 记录删除失败的附件
                            if (deleteResult.failed.length > 0) {
                                console.warn(`删除云端附件失败: ${deleteResult.failed.join(', ')}`);
                            }
                        }
                    }
                }
                return result;
            }
            // 如果是更新操作且包含附件
            if (change.type === 'put' && change.data && change.data._attachments) {
                // 获取新的附件ID集合
                const newAttachments = change.data._attachments as Attachment[];
                const newAttachmentIds = new Set<string>(
                    newAttachments
                        .filter(att => att.id && !att.missingAt)
                        .map(att => att.id)
                );
                // 如果有之前的记录，比较新旧附件列表
                if (existingRecords.length > 0) {
                    const existingRecord = existingRecords[0];
                    if (existingRecord?.data?._attachments) {
                        const oldAttachments = existingRecord.data._attachments as Attachment[];
                        const oldAttachmentIds = new Set<string>(
                            oldAttachments
                                .filter(att => att.id && !att.missingAt)
                                .map(att => att.id)
                        );
                        // 收集需要删除的附件（在旧版本中存在但新版本中不存在）
                        const attachmentIdsToDelete = oldAttachments
                            .filter(att => att.id && !newAttachmentIds.has(att.id))
                            .map(att => att.id);
                        // 批量删除不再需要的附件
                        if (attachmentIdsToDelete.length > 0) {
                            const deleteResult = await this.cloudAdapter.deleteFiles(attachmentIdsToDelete);
                            result.deletedAttachments = deleteResult.deleted;
                            if (deleteResult.failed.length > 0) {
                                console.warn(`删除云端旧附件失败: ${deleteResult.failed.join(', ')}`);
                            }
                        }
                        // 确定要上传的附件和无需处理的附件
                        for (const id of newAttachmentIds) {
                            if (!oldAttachmentIds.has(id)) {
                                result.attachmentsToUpload.push(id);
                            } else {
                                result.unchangedAttachments.push(id);
                            }
                        }
                    } else {
                        // 没有旧附件，所有新附件都需要上传
                        result.attachmentsToUpload = Array.from(newAttachmentIds);
                    }
                } else {
                    // 没有找到之前的记录，所有新附件都需要上传
                    result.attachmentsToUpload = Array.from(newAttachmentIds);
                }
            }
            return result;
        } catch (error) {
            console.warn(`处理附件变更分析失败:`, error);
            return result;
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


    // 更新最新变更版本号
    async updateLatestVersion(version: number): Promise<void> {
        try {
            await this.cloudAdapter.putBulk(this.META_STORE, [{
                _delta_id: this.VERSION_KEY,
                value: version
            }]);
        } catch (error) {
            console.error('更新最新版本号失败:', error);
        }
    }


    // 获取最新数据的时间戳（最近一次同步）
    async getLatestVersion(): Promise<SyncResponse> {
        try {
            const items = await this.cloudAdapter.readBulk<{ _delta_id: string, value: number }>(
                this.META_STORE,
                [this.VERSION_KEY]
            );
            if (items.length > 0 && items[0].value) {
                return {
                    success: true,
                    version: items[0].value
                };
            }
            return {
                success: true,
                version: 0
            };
        } catch (error) {
            console.error('获取最新版本号失败:', error);
            return {
                success: false,
                error: this.getErrorMessage(error)
            };
        }
    }

}
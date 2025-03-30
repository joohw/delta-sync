// core/syncManager.ts
// 同步管理器，提供轻量级的同步API，处理本地和远程数据的双向同步

import { SyncResponse, Attachment, DataChange, FileItem } from './types'
import { LocalCoordinator } from './LocalCoordinator';
import { CloudCoordinator } from './CloudCoordinator';



export class SyncManager {
  private isSyncing: boolean = false;
  private localCoordinator: LocalCoordinator;
  private cloudCoordinator: CloudCoordinator;

  constructor(
    localCoordinator: LocalCoordinator,
    cloudCoordinator: CloudCoordinator,
  ) {
    this.localCoordinator = localCoordinator;
    this.cloudCoordinator = cloudCoordinator;
  }

  // 推送本地变更到云端
  async pushChanges(limit: number = 100): Promise<SyncResponse> {
    if (this.isSyncing) {
      return {
        success: false,
        error: '推送更改失败，同步操作正在进行中'
      };
    }
    try {
      // 检查云端版本号，确保本地是最新的
      const cloudVersionResponse = await this.cloudCoordinator.getLatestVersion();
      if (cloudVersionResponse.version === undefined || cloudVersionResponse.version === null) {
        return cloudVersionResponse;
      }
      console.log('开始推送本地的更新');
      const cloudVersion = cloudVersionResponse.version || 0;
      const localVersion = await this.localCoordinator.getCurrentVersion();
      if (cloudVersion > localVersion) {
        console.log('检测到云端有新的变更，先返回提示');
        return {
          success: false,
          error: '云端有新数据需要先同步，请先执行完整同步操作'
        };
      }
      this.isSyncing = true;
      const pendingChanges = await this.localCoordinator.getPendingChanges(cloudVersion, limit);
      if (pendingChanges.length === 0) {
        console.log('当前版本已经是最新，无需推送');
        return {
          success: true,
          processed: 0,
          version: localVersion
        };
      }
      // 将变更发送到云端
      const response = await this.cloudCoordinator.processPushRequest(pendingChanges);
      // 收集需要处理的附件
      const attachmentPositions = new Map<string, {
        changeIndex: number,
        attachmentIndex: number
      }>();
      const attachmentsToDelete: string[] = [];
      // 处理每个变更中的附件
      for (let i = 0; i < pendingChanges.length; i++) {
        const change = pendingChanges[i];
        if (change.type === 'put' && change.data && change.data._attachments) {
          const attachmentChanges = await this.cloudCoordinator.processAttachmentChanges(change);
          // 记录需要上传的附件信息
          for (let j = 0; j < change.data._attachments.length; j++) {
            const attachment = change.data._attachments[j];
            if (attachmentChanges.attachmentsToUpload.includes(attachment.id)) {
              attachmentPositions.set(attachment.id, {
                changeIndex: i,
                attachmentIndex: j
              });
            }
          }
          // 记录需要删除的附件
          attachmentsToDelete.push(...attachmentChanges.deletedAttachments);
        }
      }
      // 处理附件
      let attachmentProcessed = 0;
      let attachmentFailed = 0;
      // 处理需要上传的附件
      if (attachmentPositions.size > 0) {
        // 读取文件内容
        const fileIds = Array.from(attachmentPositions.keys());
        const filesMap = await this.localCoordinator.localAdapter.readFiles(fileIds);
        // 创建上传项并记录失败项
        const fileItems: FileItem[] = [];
        const failedAttachments: { changeIndex: number, attachmentIndex: number, id: string }[] = [];
        for (const id of fileIds) {
          const fileContent = filesMap.get(id);
          const position = attachmentPositions.get(id);
          if (fileContent && position) {
            fileItems.push({
              content: fileContent,
              fileId: id
            });
          } else if (position) {
            failedAttachments.push({
              changeIndex: position.changeIndex,
              attachmentIndex: position.attachmentIndex,
              id
            });
          }
        }
        // 标记失败的附件
        if (failedAttachments.length > 0) {
          this.markAttachmentsAsMissing(failedAttachments, pendingChanges);
          attachmentFailed += failedAttachments.length;
        }
        // 上传文件
        if (fileItems.length > 0) {
          try {
            const uploadedAttachments = await this.cloudCoordinator.cloudAdapter.saveFiles(fileItems);
            // 更新附件信息
            for (const uploadedAttachment of uploadedAttachments) {
              const position = attachmentPositions.get(uploadedAttachment.id);
              if (position) {
                const change = pendingChanges[position.changeIndex];
                const attachments = change.data!._attachments as Attachment[];
                attachments[position.attachmentIndex] = uploadedAttachment;
                attachmentProcessed++;
              }
            }
            // 处理上传失败的附件
            const uploadedIds = new Set(uploadedAttachments.map(a => a.id));
            const uploadFailedItems = Array.from(attachmentPositions.entries())
              .filter(([id]) => !uploadedIds.has(id))
              .map(([id, position]) => ({
                changeIndex: position.changeIndex,
                attachmentIndex: position.attachmentIndex,
                id
              }));

            if (uploadFailedItems.length > 0) {
              this.markAttachmentsAsMissing(uploadFailedItems, pendingChanges);
              attachmentFailed += uploadFailedItems.length;
            }
          } catch (error) {
            console.error('批量上传附件失败:', error);
            // 标记所有待上传附件为失败
            const allFailedItems = Array.from(attachmentPositions.entries())
              .map(([id, position]) => ({
                changeIndex: position.changeIndex,
                attachmentIndex: position.attachmentIndex,
                id
              }));

            this.markAttachmentsAsMissing(allFailedItems, pendingChanges);
            attachmentFailed += allFailedItems.length;
          }
        }
      }
      if (response.success) {
        if (!response.version) {
          return {
            success: false,
            error: '服务器返回无效的版本号'
          };
        }
        return {
          ...response,
          info: {
            ...(response.info || {}),
            attachments_processed: attachmentProcessed,
            attachments_failed: attachmentFailed
          }
        };
      }
      return response;
    } catch (error) {
      console.error('推送变更时出错:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      };
    } finally {
      this.isSyncing = false;
    }
  }




  // 从云端拉取变更到本地
  async pullChanges(): Promise<SyncResponse> {
    console.log('开始拉取云端的更新');
    if (this.isSyncing) {
      return {
        success: false,
        error: '拉取更改失败，同步操作正在进行中'
      };
    }
    try {
      this.isSyncing = true;
      const localVersion = await this.localCoordinator.getCurrentVersion();
      const response = await this.cloudCoordinator.processPullRequest(localVersion);
      if (!response.success) {
        console.error('拉取云端的数据失败');
        return response;
      }
      if (!response.changes || response.changes.length === 0) {
        console.log('云端没有新数据');
        return {
          success: true,
          processed: 0,
          version: response.version
        }
      }
      // 应用可能的远程变更
      await this.localCoordinator.applyRemoteChange(response.changes);
      // 收集需要下载的附件ID
      const attachmentsToDownload = new Set<string>();
      // 处理所有变更
      for (const change of response.changes) {
        // 分析附件变更并收集需要下载的附件ID
        if (change.type === 'put' && change.data && change.data._attachments) {
          const attachmentChanges = await this.localCoordinator.applyAttachmentChanges(change);
          for (const attachmentId of attachmentChanges.attachmentsToDownload) {
            attachmentsToDownload.add(attachmentId);
          }
        }
      }
      // 应用数据变更
      await this.localCoordinator.applyRemoteChange(response.changes);
      // 批量下载附件
      let attachmentProcessed = 0;
      let attachmentFailed = 0;
      if (attachmentsToDownload.size > 0) {
        try {
          // 批量读取云端文件
          const attachmentIdsArray = Array.from(attachmentsToDownload);
          const filesMap = await this.cloudCoordinator.cloudAdapter.readFiles(attachmentIdsArray);
          // 准备批量写入本地
          const fileItems: FileItem[] = [];
          for (const attachmentId of attachmentIdsArray) {
            const fileContent = filesMap.get(attachmentId);
            if (fileContent) {
              fileItems.push({
                content: fileContent,
                fileId: attachmentId,
              });
            } else {
              attachmentFailed++;
            }
          }
          // 批量写入本地
          if (fileItems.length > 0) {
            const savedAttachments = await this.localCoordinator.localAdapter.saveFiles(fileItems);
            attachmentProcessed = savedAttachments.length;
            attachmentFailed += (fileItems.length - savedAttachments.length);
          }
        } catch (error) {
          console.error('批量处理云端附件失败:', error);
          attachmentFailed = attachmentsToDownload.size;
        }
      }
      return {
        success: true,
        processed: response.changes.length,
        version: response.version,
        info: {
          attachments_processed: attachmentProcessed,
          attachments_failed: attachmentFailed
        }
      };
    } catch (error) {
      console.error('拉取变更时出错:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      };
    } finally {
      this.isSyncing = false;
    }
  }


  // 执行完整的双向同步
  async syncAll(): Promise<boolean> {
    if (this.isSyncing) {
      return false;
    }
    try {
      await this.pullChanges();
      await this.pushChanges();
      return true;
    } catch (error) {
      console.error('执行完整的双向同步时出错:', error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }


  // 执行数据库维护操作
  async performMaintenance(): Promise<void> {
    await this.localCoordinator.performMaintenance();
    await this.cloudCoordinator.performMaintenance();
  }


  // 标记失败的附件
  private markAttachmentsAsMissing(
    attachmentItems: { changeIndex: number, attachmentIndex: number, id: string }[],
    changes: DataChange[]
  ): void {
    const now = Date.now();
    for (const item of attachmentItems) {
      const change = changes[item.changeIndex];
      if (change?.data?._attachments) {
        const attachments = change.data._attachments as Attachment[];
        if (attachments[item.attachmentIndex]) {
          attachments[item.attachmentIndex] = {
            ...attachments[item.attachmentIndex],
            missingAt: now
          };
        }
      }
    }
  }
}
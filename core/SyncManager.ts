// core/syncManager.ts
// 同步管理器，提供轻量级的同步API，处理本地和远程数据的双向同步

import {
  BaseModel,
  SyncResponse,
  Attachment,
  DataChange,
  FileItem,
  AttachmentChange,
  getOriginalId,
} from './types'
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



  // 从云端拉取变更到本地
  async pushChanges(limit: number = 100): Promise<boolean> {
    if (this.isSyncing) {
      console.error('推送更改失败，同步操作正在进行中');
      return false;
    }
    try {
      // 1. 检查云端版本号，确保本地是最新的
      const cloudVersion = await this.cloudCoordinator.getLatestVersion();
      const localVersion = await this.localCoordinator.getCurrentVersion();
      console.log(`准备推送变更: 本地版本=${localVersion}, 云端版本=${cloudVersion}`);
      if (cloudVersion > localVersion) {
        console.error('云端有新数据需要先同步，请先执行完整同步操作');
        return false;
      }
      this.isSyncing = true;
      // 2. 获取待推送的本地变更
      const pendingChanges = await this.localCoordinator.getPendingChanges(cloudVersion, limit);
      if (pendingChanges.length === 0) {
        console.log('没有需要推送的本地变更');
        return true;
      }
      console.log(`获取到 ${pendingChanges.length} 个待推送变更`);
      // 3. 收集附件变更
      const allAttachmentChanges = this.collectAttachmentChanges(pendingChanges);
      console.log(`从待推送变更中收集到 ${allAttachmentChanges.length} 个附件变更`);
      // 4. 处理附件变更
      if (allAttachmentChanges.length > 0) {
        console.log(`开始处理 ${allAttachmentChanges.length} 个附件变更 (上传和删除)`);
        const result = await this.processAttachmentChanges('push', allAttachmentChanges);
        // 标记失败的附件为缺失
        if (result.attachmentIds.failed.length > 0) {
          console.log(`标记 ${result.attachmentIds.failed.length} 个失败的附件为缺失状态`);
          this.markFailedAttachments(pendingChanges, result.attachmentIds.failed);
        }
        console.log(`附件处理完成: 成功=${result.processed}, 失败=${result.failed}`);
      }
      // 5. 将变更推送到云端
      console.log(`开始将 ${pendingChanges.length} 个变更推送到云端`);
      const response = await this.cloudCoordinator.processPushRequest(pendingChanges);
      if (!response.success) {
        console.error('推送变更到云端失败:', response.error);
        return false;
      }
      if (!response.version) {
        console.error('服务器返回无效的版本号');
        return false;
      }
      console.log(`变更推送成功: 处理=${response.processed}, 新版本=${response.version}`);
      return true;
    } catch (error) {
      console.error('推送变更时出错:', error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }


  // 推送本地变更到云端,推送在最新的更改上工作
  async pullChanges(): Promise<boolean> {
    console.log('开始拉取云端的更新');
    if (this.isSyncing) {
      console.error('拉取更改失败，同步操作正在进行中');
      return false;
    }
    try {
      this.isSyncing = true;
      // 1. 获取本地版本号
      const localVersion = await this.localCoordinator.getCurrentVersion();
      console.log(`本地当前版本: ${localVersion}`);
      // 2. 从云端获取变更
      const response = await this.cloudCoordinator.processPullRequest(localVersion);
      if (!response.success) {
        console.error('拉取云端的数据失败:', response.error);
        return false;
      }
      if (!response.changes || response.changes.length === 0) {
        console.log('云端没有新数据');
        return true;
      }
      // 3. 收集附件变更
      const allAttachmentChanges = this.collectAttachmentChanges(response.changes);
      console.log(`从云端变更中收集到 ${allAttachmentChanges.length} 个附件变更`);
      // 4. 处理附件变更
      if (allAttachmentChanges.length > 0) {
        console.log(`开始处理 ${allAttachmentChanges.length} 个附件变更 (下载和删除)`);
        const result = await this.processAttachmentChanges('pull', allAttachmentChanges);
        console.log(`附件处理完成: 成功=${result.processed}, 失败=${result.failed}`);
      }
      // 5. 应用数据变更到本地
      await this.localCoordinator.applyRemoteChange(response.changes);
      console.log(`已将 ${response.changes.length} 个云端变更应用到本地，新版本: ${response.version}`);
      return true;
    } catch (error) {
      console.error('拉取变更时出错:', error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }



  async processAttachmentChanges(
    direction: 'push' | 'pull',
    attachmentChanges: AttachmentChange[]
  ): Promise<{
    processed: number,
    failed: number,
    attachmentIds: {
      processed: string[],
      failed: string[]
    }
  }> {
    // 结果统计
    const result = {
      processed: 0,
      failed: 0,
      attachmentIds: {
        processed: [] as string[],
        failed: [] as string[]
      }
    };
    // 如果没有变更，直接返回
    if (attachmentChanges.length === 0) {
      return result;
    }
    // 源和目标适配器
    const sourceAdapter = direction === 'push' ?
      this.localCoordinator.localAdapter :
      this.cloudCoordinator.cloudAdapter;
    const targetAdapter = direction === 'push' ?
      this.cloudCoordinator.cloudAdapter :
      this.localCoordinator.localAdapter;
    try {
      // 1. 批量处理删除操作
      const deleteIds = attachmentChanges
        .filter(change => change.type === 'delete')
        .map(change => change.id);
      if (deleteIds.length > 0) {
        const deleteResult = await targetAdapter.deleteFiles(deleteIds)
          .catch(err => {
            console.error(`批量删除${direction === 'push' ? '云端' : '本地'}附件失败:`, err);
            return { deleted: [], failed: deleteIds };
          });
        result.processed += deleteResult.deleted.length;
        result.failed += deleteResult.failed.length;
        result.attachmentIds.processed.push(...deleteResult.deleted);
        result.attachmentIds.failed.push(...deleteResult.failed);
      }
      // 2. 批量处理上传/下载操作
      const transferIds = attachmentChanges
        .filter(change => change.type === 'put')
        .map(change => change.id);
      if (transferIds.length > 0) {
        // 读取源文件
        const filesMap = await sourceAdapter.readFiles(transferIds)
          .catch(err => {
            console.error(`批量读取${direction === 'push' ? '本地' : '云端'}附件失败:`, err);
            result.failed += transferIds.length;
            result.attachmentIds.failed.push(...transferIds);
            return new Map<string, Blob | ArrayBuffer | null>();
          });
        // 准备传输文件
        const fileItems: FileItem[] = [];
        const readFailedIds: string[] = [];
        for (const id of transferIds) {
          const content = filesMap.get(id);
          if (content) {
            fileItems.push({ fileId: id, content });
          } else {
            readFailedIds.push(id);
          }
        }
        // 记录读取失败的文件
        if (readFailedIds.length > 0) {
          result.failed += readFailedIds.length;
          result.attachmentIds.failed.push(...readFailedIds);
        }
        // 写入目标
        if (fileItems.length > 0) {
          const savedAttachments = await targetAdapter.saveFiles(fileItems)
            .catch(err => {
              console.error(`批量保存${direction === 'push' ? '云端' : '本地'}附件失败:`, err);
              result.failed += fileItems.length;
              result.attachmentIds.failed.push(...fileItems.map(item => item.fileId));
              return [] as Attachment[];
            });
          // 记录保存结果
          const savedIds = savedAttachments.map(att => att.id);
          result.processed += savedIds.length;
          result.attachmentIds.processed.push(...savedIds);
          // 标记保存失败的文件
          const failedToSaveIds = fileItems
            .map(item => item.fileId)
            .filter(id => !savedIds.includes(id));
          if (failedToSaveIds.length > 0) {
            result.failed += failedToSaveIds.length;
            result.attachmentIds.failed.push(...failedToSaveIds);
          }
        }
      }
      return result;
    } catch (error) {
      console.error(`处理附件变更时发生意外错误:`, error);
      return {
        processed: 0,
        failed: attachmentChanges.length,
        attachmentIds: {
          processed: [],
          failed: attachmentChanges.map(change => change.id)
        }
      };
    }
  }




  collectAttachmentChanges(
    changes: DataChange[]
  ): AttachmentChange[] {
    const attachmentChanges: AttachmentChange[] = [];
    for (const change of changes) {
      if (change.attachmentChanges) {
        attachmentChanges.push(...change.attachmentChanges);
        continue;
      }
      if (change.type === 'delete') {
        continue;
      }
      if (change.type === 'put' && change.data && change.data._attachments) {
        const attachments = change.data._attachments as Attachment[];
        for (const attachment of attachments) {
          if (attachment.id) {
            attachmentChanges.push({
              id: attachment.id,
              type: 'put'
            });
          }
        }
      }
    }
    return attachmentChanges;
  }



  // 标记失败的附件
  private markFailedAttachments(changes: DataChange[], failedIds: string[]): void {
    const now = Date.now();
    const failedIdSet = new Set(failedIds);
    for (const change of changes) {
      if (change.type === 'put' && change.data && change.data._attachments) {
        const attachments = change.data._attachments as Attachment[];
        for (let i = 0; i < attachments.length; i++) {
          if (failedIdSet.has(attachments[i].id)) {
            attachments[i].missingAt = now;
          }
        }
      }
    }
  }




}
// core/syncManager.ts
// 同步管理器，提供轻量级的同步API，处理本地和远程数据的双向同步

import {
  Attachment,
  FileItem,
  AttachmentChange,
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


  async pushChanges(limit: number = 100): Promise<boolean> {
    if (this.isSyncing) {
      console.log("同步已在进行中，跳过本次推送");
      return false;
    }
    try {
      const localVersion = await this.localCoordinator.getCurrentVersion();
      const cloudVersion = await this.cloudCoordinator.getLatestVersion();
      console.log(`版本信息:
            - 本地版本: ${localVersion}
            - 云端版本: ${cloudVersion}`);
      if (cloudVersion > localVersion) {
        console.warn("请先拉取最新的云端版本，才能进行推送");
        return false;
      }
      this.isSyncing = true;
      console.log("开始推送变更...");
      // 1. 获取本地待推送的附件变更
      const attachmentChanges = await this.localCoordinator.getPendingAttachmentChanges(cloudVersion, limit);
      console.log(`待推送的附件变更数量: ${attachmentChanges.length}`);
      // 2. 先处理附件变更
      if (attachmentChanges.length > 0) {
        console.log("=== 开始处理附件变更 ===");
        console.log(`附件变更详情:`,
          attachmentChanges.map(change => ({
            id: change._delta_id,
            version: change._version,
            type: change.type
          }))
        );
        // 2.1 处理文件传输
        const result = await this.processAttachmentChanges('push', attachmentChanges);
        console.log(`附件处理结果:
                - 成功数量: ${result.processed}
                - 失败数量: ${result.failed}
                - 成功ID: ${result.attachmentIds.processed.join(', ')}
                - 失败ID: ${result.attachmentIds.failed.join(', ')}`);
        // 2.2 处理附件变更记录
        await this.localCoordinator.applyAttachmentChanges(attachmentChanges);
        console.log("本地附件变更记录已更新");
        // 2.3 推送附件变更记录到云端
        await this.cloudCoordinator.applyAttachmentChanges(attachmentChanges);
        console.log(`推送 ${attachmentChanges.length} 个附件变更记录到云端`);
        console.log("=== 附件变更处理完成 ===");
      }
      // 3. 再处理数据变更
      const pendingChanges = await this.localCoordinator.getPendingChanges(limit);
      console.log(`待推送的数据变更数量: ${pendingChanges.length}`);
      if (pendingChanges.length > 0) {
        console.log("=== 开始处理数据变更 ===");
        const response = await this.cloudCoordinator.applyChanges(pendingChanges);
        if (!response.success) {
          console.error("推送数据变更失败:", response.error);
          return false;
        }
        if (response && response.success && response.version) {
          await this.localCoordinator.updateCurrentVersion(response.version);
          console.log(`已更新本地版本到: ${response.version}`);
        }
      }
      console.log("推送变更完成");
      return true;
    } catch (error) {
      console.error('推送变更时发生错误:', error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }



  async pullChanges(): Promise<boolean> {
    if (this.isSyncing) {
      console.log("同步已在进行中，跳过本次拉取");
      return false;
    }
    try {
      this.isSyncing = true;
      console.log("开始拉取变更...");
      const localVersion = await this.localCoordinator.getCurrentVersion();
      const cloudVersion = await this.cloudCoordinator.getLatestVersion();
      if (cloudVersion === 0 || cloudVersion <= localVersion) {
        console.log("云端没有更新，无需拉取变更");
        return true;
      }
      console.log(`当前本地版本: ${localVersion}, 云端最新版本: ${cloudVersion}`);
      // 1. 拉取附件变更
      const attachmentChanges = await this.cloudCoordinator.getAttachmentChanges(localVersion);
      console.log(`待拉取的附件变更数量: ${attachmentChanges.length}`);
      if (attachmentChanges.length > 0) {
        console.log("=== 开始处理附件变更 ===");
        console.log(`附件变更详情:`,
          attachmentChanges.map(change => ({
            id: change._delta_id,
            version: change._version,
            type: change.type
          }))
        );
        const result = await this.processAttachmentChanges('pull', attachmentChanges);
        console.log(`附件处理结果:
              - 成功数量: ${result.processed}
              - 失败数量: ${result.failed}
              - 成功ID: ${result.attachmentIds.processed.join(', ')}
              - 失败ID: ${result.attachmentIds.failed.join(', ')}`);
        await this.localCoordinator.applyAttachmentChanges(attachmentChanges);
        console.log(`已更新 ${attachmentChanges.length} 个附件变更记录`);
        console.log("=== 附件变更处理完成 ===");
      }
      // 2. 拉取数据变更
      console.log("开始拉取数据变更...");
      const response = await this.cloudCoordinator.getPendingChanges(localVersion);
      if (!response.success || !response.changes) {
        console.error("拉取数据变更失败:", response.error);
        return false;
      }
      console.log(`获取到 ${response.changes.length} 个数据变更`);
      if (response.changes.length > 0) {
        await this.localCoordinator.applyDataChange(response.changes);
        console.log(`已应用数据变更，最新版本: ${response.version}`);
      }
      console.log("拉取变更完成");
      return true;
    } catch (error) {
      console.error('拉取变更时发生错误:', error);
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
        .map(change => change._delta_id);
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
        .map(change => change._delta_id);
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
          failed: attachmentChanges.map(change => change._delta_id)
        }
      };
    }
  }



}
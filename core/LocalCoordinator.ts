// core/LocalCoordinator.ts
// 本地的协调层，包装数据库适配器同时提供自动化的变更记录


import {
  BaseModel,
  DatabaseAdapter,
  DataChange,
  getChangeId,
  getOriginalId,
  SyncOperationType,
  FileItem,
  Attachment,
  AttachmentChange,
  LocalChangeRecord,

} from './types';
import { EncryptionConfig } from './SyncConfig'


export class LocalCoordinator {
  public localAdapter: DatabaseAdapter;
  private encryptionConfig?: EncryptionConfig;
  private readonly LOCAL_CHANGES_STORE = 'local_changes'; // 独立的变更表，记录所有数据修改


  constructor(localAdapter: DatabaseAdapter, encryptionConfig?: EncryptionConfig) {
    this.localAdapter = localAdapter;
    this.encryptionConfig = encryptionConfig;
  }

  async initialize(): Promise<void> {
    await this.localAdapter.initSync();
  }


  // 写入数据并自动跟踪变更
  async putBulk<T extends BaseModel>(
    storeName: string,
    items: T[],
    skipTracking: boolean = false  // 是否跳过变更跟踪，默认为false
  ): Promise<T[]> {
    const nextVersion = await this.nextVersion();
    const updatedItems = items.map(item => ({
      ...item,
      _version: nextVersion // 添加版本号
    }));
    const result = await this.localAdapter.putBulk(storeName, updatedItems);
    if (!skipTracking) {
      for (const item of updatedItems) {
        await this.recordChange(
          storeName,
          item,
          'put'
        );
      }
    }
    return result;
  }



  // 删除数据并且自动写入变更
  async deleteBulk(
    storeName: string,
    ids: string[],
    skipTracking: boolean = false
  ): Promise<void> {
    const items = await this.localAdapter.readBulk<BaseModel>(storeName, ids);
    for (const item of items) {
      if (item._attachments) {
        const attachmentIds = item._attachments
          .filter(att => att.id && !att.missingAt)
          .map(att => att.id);
        if (attachmentIds.length > 0) {
          await this.localAdapter.deleteFiles(attachmentIds);
        }
      }
    }
    await this.localAdapter.deleteBulk(storeName, ids);
    if (!skipTracking) {
      for (const item of items) {
        await this.recordChange(
          storeName,
          {
            _delta_id: item._delta_id,
            _version: item._version
          },
          'delete'
        );
      }
    }
  }



  // 记录变更，包括附件的变更
  private async recordChange<T extends BaseModel>(
    storeName: string,
    data: T,
    operationType: SyncOperationType
  ): Promise<void> {
    const syncId = getChangeId(storeName, data._delta_id);
    const version = await this.nextVersion();
    // 计算附件变更
    let attachmentChanges: AttachmentChange[] = [];
    if (data._attachments) {
      const existingItems = await this.localAdapter.readBulk<BaseModel>(
        storeName,
        [data._delta_id]
      );
      const oldAttachmentIds = new Set<string>();
      if (existingItems.length > 0 && existingItems[0]._attachments) {
        existingItems[0]._attachments
          .filter(att => att.id && !att.missingAt)
          .forEach(att => oldAttachmentIds.add(att.id));
      }
      // 对于 put 操作:
      if (operationType === 'put') {
        const newAttachmentIds = new Set<string>(
          data._attachments
            .filter(att => att.id && !att.missingAt)
            .map(att => att.id)
        );
        // 需要删除的附件
        for (const oldId of oldAttachmentIds) {
          if (!newAttachmentIds.has(oldId)) {
            attachmentChanges.push({
              id: oldId,
              type: 'delete'
            });
          }
        }
        // 需要添加的附件
        for (const attachment of data._attachments) {
          if (attachment.id && !attachment.missingAt && !oldAttachmentIds.has(attachment.id)) {
            attachmentChanges.push({
              id: attachment.id,
              type: 'put'
            });
          }
        }
      }
      else if (operationType === 'delete') {
        for (const oldId of oldAttachmentIds) {
          attachmentChanges.push({
            id: oldId,
            type: 'delete'
          });
        }
      }
    }
    const changeRecord: LocalChangeRecord = {
      _delta_id: syncId,
      _store: storeName,
      _version: version,
      type: operationType,
      originalId: data._delta_id,
      attachmentChanges: attachmentChanges.length > 0 ? attachmentChanges : undefined
    };
    console.log(`记录变更：storeName=${storeName}, id=${data._delta_id}, version=${version}, operation=${operationType}`);
    await this.localAdapter.putBulk(this.LOCAL_CHANGES_STORE, [changeRecord]);
  }



  // 从云端同步数据
  async applyRemoteChange<T extends BaseModel>(changes: DataChange<T>[]): Promise<void> {
    // 批量写入本地变更表
    const changesByStore = new Map<string, { puts: T[], deletes: string[] }>();
    for (const change of changes) {
      if (!changesByStore.has(change._store)) {
        changesByStore.set(change._store, { puts: [], deletes: [] });
      }
      const storeChanges = changesByStore.get(change._store)!;
      if (change.type === 'put' && change.data) {
        storeChanges.puts.push({
          ...change.data,
          _version: change._version
        } as T);
      } else if (change.type === 'delete') {
        const originalId = getOriginalId(change._delta_id, change._store);
        storeChanges.deletes.push(originalId);
      }
    }
    // 应用数据变更，直接使用适配器方法
    for (const [storeName, storeChanges] of changesByStore.entries()) {
      if (storeChanges.puts.length > 0) {
        console.log(`直接写入远程数据到本地：${storeChanges.puts.length}条`);
        await this.localAdapter.putBulk(storeName, storeChanges.puts);
      }
      if (storeChanges.deletes.length > 0) {
        console.log(`直接删除远程数据到本地：${storeChanges.deletes.length}条`);
        await this.localAdapter.deleteBulk(storeName, storeChanges.deletes);
      }
    }
    // 批量写入本地变更表
    const localChangeRecords: LocalChangeRecord[] = changes.map(change => {
      const originalId = change.type === 'delete'
        ? getOriginalId(change._delta_id, change._store)
        : change.data?._delta_id || '';
      return {
        _delta_id: change._delta_id,
        _store: change._store,
        _version: change._version,
        type: change.type,
        originalId: originalId,
      };
    });
    if (localChangeRecords.length > 0) {
      console.log(`记录远程变更到本地变更表: ${localChangeRecords.length}条`);
      await this.localAdapter.putBulk(this.LOCAL_CHANGES_STORE, localChangeRecords);
    }
  }



  // 获取待同步的变更记录
  async getPendingChanges(since: number, limit: number = 100): Promise<DataChange[]> {
    // 读取变更记录
    const result = await this.localAdapter.readByVersion<LocalChangeRecord>(this.LOCAL_CHANGES_STORE, {
      since: since,
      limit: limit,
    });
    // 按版本排序并限制数量
    const localChanges = result.items
      .sort((a, b) => (a._version || 0) - (b._version || 0))
      .slice(0, limit);
    const fullChanges: DataChange[] = [];
    for (const change of localChanges) {
      try {
        const items = await this.localAdapter.readBulk<BaseModel>(change._store, [change.originalId]);
        if (change.type === 'put') {
          if (items.length > 0) {
            // 如果有附件变更，确保数据中包含这些信息
            const dataChange: DataChange = {
              _delta_id: change._delta_id,
              _store: change._store,
              _version: change._version,
              type: change.type,
              data: { ...items[0] }
            };

            fullChanges.push(dataChange);
          }
        } else if (change.type === 'delete') {
          if (items.length === 0) {
            const dataChange: DataChange = {
              _delta_id: change._delta_id,
              _store: change._store,
              _version: change._version,
              type: change.type
            };
            // 如果记录了附件变更，也包含进来
            if (change.attachmentChanges?.length) {
              dataChange.attachmentChanges = change.attachmentChanges;
            }
            fullChanges.push(dataChange);
          }
        }
      } catch (error) {
        console.error(`处理变更记录时出错:`, error);
      }
    }
    return fullChanges;
  }



  // 维护方法,清理旧的变更记录
  async performMaintenance(): Promise<void> {
    console.log("开始执行本地维护任务");
    let offset = 0;
    let hasMore = true;
    const batchSize = 1000;
    const recordsToDelete: string[] = [];
    // 分批处理所有变更记录
    while (hasMore) {
      const changesResult = await this.localAdapter.readByVersion<LocalChangeRecord>(
        this.LOCAL_CHANGES_STORE,
        {
          offset: offset,
          limit: batchSize
        }
      );
      const changes = changesResult.items;
      hasMore = changesResult.hasMore;
      for (const change of changes) {
        if (change.type === 'delete') continue;
        const items = await this.localAdapter.readBulk<BaseModel>(
          change._store,
          [change.originalId]
        );
        // 如果原始数据不存在，标记此变更记录为待删除
        if (items.length === 0) {
          recordsToDelete.push(change._delta_id);
        }
      }
      // 批量删除不一致的变更记录
      if (recordsToDelete.length > 0) {
        await this.localAdapter.deleteBulk(this.LOCAL_CHANGES_STORE, recordsToDelete);
        console.log(`已删除 ${recordsToDelete.length} 条不一致的变更记录`);
        recordsToDelete.length = 0; // 清空数组
      }
      if (changes.length < batchSize) {
        hasMore = false;
      } else {
        offset += changes.length;
      }
    }
    console.log("本地变更记录清理完成");
  }



  async nextVersion(): Promise<number> {
    try {
      const currentVersion = await this.getCurrentVersion();
      const newVersion = currentVersion + 1;
      return newVersion;
    } catch (error) {
      console.error("生成新版本号失败:", error);
      throw new Error(`版本号更新失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  // 获取当前版本号(Todo优化查询方式)
  async getCurrentVersion(): Promise<number> {
    try {
      const result = await this.localAdapter.readByVersion<LocalChangeRecord>(
        this.LOCAL_CHANGES_STORE,
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
      console.warn("读取版本号失败:", error);
      return 0;
    }
  }

  async attachFile(
    modelId: string,
    storeName: string,
    file: File | Blob | ArrayBuffer,
    filename: string,
    mimeType: string,
    metadata: any = {},
  ): Promise<Attachment> {
    // 首先获取原始模型
    const items = await this.localAdapter.readBulk<BaseModel>(storeName, [modelId]);
    if (items.length === 0) {
      throw new Error(`无法找到ID为 ${modelId} 的模型`);
    }
    const fileId = `attachment_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const fileItem: FileItem = {
      fileId: fileId,
      content: file
    };
    // 保存文件到存储
    const [savedAttachment] = await this.localAdapter.saveFiles([fileItem]);
    const attachment: Attachment = {
      id: savedAttachment.id,
      filename: filename,
      mimeType: mimeType, // 明确保留为必需参数
      size: savedAttachment.size,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: metadata || {}
    };
    const model = items[0];
    // 添加附件到模型
    if (!model._attachments) {
      model._attachments = [];
    }
    model._attachments.push(attachment);
    const targetStoreName = model._store || storeName;
    await this.putBulk(targetStoreName, [model]);
    return attachment;
  }


  // 从模型中移除附件
  async detachFile<T extends BaseModel>(
    model: T,
    attachmentId: string
  ): Promise<T> {
    if (!model._attachments) {
      return model;
    }
    const index = model._attachments.findIndex(att => att.id === attachmentId);
    if (index === -1) {
      return model;
    }
    await this.localAdapter.deleteFiles([attachmentId]);
    model._attachments.splice(index, 1);
    return model;
  }




}
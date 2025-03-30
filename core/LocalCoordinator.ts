// core/LocalCoordinator.ts
// 本地的协调层，包装数据库适配器同时提供自动化的变更记录


import {
  BaseModel,
  DatabaseAdapter,
  DataChange, getChangeId, getOriginalId,
  SyncOperationType, FileItem,
  Attachment, LocalChangeRecord
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
    skipVersionIncrement: boolean = false  // 是否跳过版本号自增，默认为false
  ): Promise<T[]> {
    const updatedItems = items.map(item => ({
      ...item,
    }));
    const result = await this.localAdapter.putBulk(storeName, updatedItems);
    for (const item of updatedItems) {
      await this.trackChange(
        storeName,
        item,
        'put',
        skipVersionIncrement,
      );
    }
    return result;
  }


  // 删除数据并且自动写入变更
  async deleteBulk(
    storeName: string,
    ids: string[],
    skipVersionIncrement: boolean = false  // 是否跳过版本号自增，默认为false
  ): Promise<void> {
    const now = Date.now();
    const items = await this.localAdapter.readBulk<BaseModel>(storeName, ids);
    await this.localAdapter.deleteBulk(storeName, ids);
    for (const item of items) {
      const deleteItem = {
        _delta_id: item._delta_id,
        _version: item._version // 保留原始版本号，以便传递给trackChange
      };
      await this.trackChange(
        storeName,
        deleteItem,
        'delete',
        false,
      );
    }
  }



  // 从云端同步数据（使用现有版本号）
  async applyRemoteChange<T extends BaseModel>(changes: DataChange<T>[]): Promise<void> {
    let maxVersion = 0;
    const changesByStore = new Map<string, { puts: T[], deletes: string[] }>();
    for (const change of changes) {
      // 获取最大版本号
      if (change._version > maxVersion) {
        maxVersion = change._version;
      }
      if (!changesByStore.has(change._store)) {
        changesByStore.set(change._store, { puts: [], deletes: [] });
      }
      const storeChanges = changesByStore.get(change._store)!;
      if (change.type === 'put' && change.data) {
        storeChanges.puts.push({
          ...change.data,
          _version: change._version  // 确保版本号被保留
        } as T);
      } else if (change.type === 'delete') {
        const originalId = getOriginalId(change._delta_id, change._store);
        storeChanges.deletes.push(originalId);
      }
    }
    // 应用数据变更（使用现有版本号）
    for (const [storeName, storeChanges] of changesByStore.entries()) {
      if (storeChanges.puts.length > 0) {
        console.log(`写入数据到本地`);
        await this.putBulk(storeName, storeChanges.puts, true);  // 跳过版本号自增
      }
      if (storeChanges.deletes.length > 0) {
        console.log(`删除数据到本地`);
        await this.deleteBulk(storeName, storeChanges.deletes, true);  // 跳过版本号自增
      }
    }
  }


  // 获取待同步的变更记录  待修复
  async getPendingChanges(since: number, limit: number = 100): Promise<DataChange[]> {
    const result = await this.localAdapter.read<LocalChangeRecord>(this.LOCAL_CHANGES_STORE, {
      since: since,
      limit: limit,
    });
    console.log(`获取本地变更记录since=${since}, limit=${limit}`);
    const localChanges = result.items
      .sort((a, b) => (a._version || 0) - (b._version || 0))
      .slice(0, limit);
    const fullChanges: DataChange[] = [];
    for (const change of localChanges) {
      if (change.type === 'put') {
        try {
          const items = await this.localAdapter.readBulk<BaseModel>(change._store, [change.originalId]);
          if (items.length > 0) {
            fullChanges.push({
              _delta_id: change._delta_id,
              _store: change._store,
              _version: change._version,
              type: change.type,
              data: { ...items[0], _store: change._store }
            });
          } else {
            console.warn(`无法找到原始数据: store=${change._store}, id=${change.originalId}`);
          }
        } catch (error) {
          console.error(`处理变更记录时出错:`, error);
          // 异常处理
        }
      } else {
        // 对于delete操作，直接添加到结果中
        fullChanges.push({
          _delta_id: change._delta_id,
          _store: change._store,
          _version: change._version,
          type: change.type
        });
      }
    }
    return fullChanges;
  }


  // 应用附件的更改，返回还需要下载的附件
  async applyAttachmentChanges(change: DataChange): Promise<{
    attachmentsToDownload: string[],
    deletedAttachments: string[],
    unchangedAttachments: string[]
  }> {
    const result = {
      deletedAttachments: [] as string[],
      attachmentsToDownload: [] as string[],
      unchangedAttachments: [] as string[]
    };
    try {
      // 如果是删除操作
      if (change.type === 'delete') {
        const originalId = getOriginalId(change._delta_id, change._store);
        const existingItems = await this.localAdapter.readBulk<BaseModel>(
          change._store,
          [originalId]
        );
        if (existingItems.length > 0) {
          const existingItem = existingItems[0];
          if (existingItem._attachments) {
            // 收集要删除的附件ID
            const attachmentIdsToDelete = existingItem._attachments
              .filter(att => att.id)
              .map(att => att.id);
            if (attachmentIdsToDelete.length > 0) {
              // 批量删除附件
              const deleteResult = await this.localAdapter.deleteFiles(attachmentIdsToDelete);
              result.deletedAttachments = deleteResult.deleted;
              // 记录删除失败的附件
              if (deleteResult.failed.length > 0) {
                console.warn(`删除本地附件失败: ${deleteResult.failed.join(', ')}`);
              }
            }
          }
        }
        return result;
      }
      // 如果是更新操作且包含附件
      if (change.type === 'put' && change.data) {
        // 获取新的附件ID集合
        const newAttachments = (change.data._attachments || []) as Attachment[];
        const newAttachmentIds = new Set<string>(
          newAttachments
            .filter((att: Attachment) => att.id && !att.missingAt)
            .map((att: Attachment) => att.id)
        );
        // 从原始 store 中查找本地对应项目
        const existingItems = await this.localAdapter.readBulk<BaseModel>(
          change._store,
          [change.data._delta_id]
        );
        // 记录下所有修改前的附件ID，用于完整比对
        let oldAttachmentIds = new Set<string>();
        let oldAttachments: Attachment[] = [];
        // 如果有本地记录，比较新旧附件列表
        if (existingItems.length > 0) {
          const existingItem = existingItems[0];
          if (existingItem._attachments) {
            oldAttachments = existingItem._attachments as Attachment[];
            oldAttachmentIds = new Set<string>(
              oldAttachments
                .filter(att => att.id && !att.missingAt)
                .map(att => att.id)
            );
          }
        }
        // 收集需要删除的附件ID（在本地存在但新版本中不存在）
        const attachmentIdsToDelete = oldAttachments
          .filter(att => att.id && !att.missingAt && !newAttachmentIds.has(att.id))
          .map(att => att.id);
        // 批量删除不再需要的附件
        if (attachmentIdsToDelete.length > 0) {
          const deleteResult = await this.localAdapter.deleteFiles(attachmentIdsToDelete);
          result.deletedAttachments = deleteResult.deleted;
          if (deleteResult.failed.length > 0) {
            console.warn(`删除本地旧附件失败: ${deleteResult.failed.join(', ')}`);
          }
        }
        // 确定要下载的附件和无需处理的附件
        for (const attachment of newAttachments) {
          if (attachment.id && !attachment.missingAt) {
            if (!oldAttachmentIds.has(attachment.id)) {
              result.attachmentsToDownload.push(attachment.id);
            } else {
              result.unchangedAttachments.push(attachment.id);
            }
          }
        }
      }
      return result;
    } catch (error) {
      console.warn(`处理附件变更分析失败:`, error);
      return result;
    }
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
      const changesResult = await this.localAdapter.read<LocalChangeRecord>(
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


  // 记录完整的数据变更历史
  private async trackChange<T extends BaseModel>(
    storeName: string,
    data: T,
    operationType: SyncOperationType,
    skipVersionIncrement: boolean = false
  ): Promise<void> {
    const syncId = getChangeId(storeName, data._delta_id);
    const version = skipVersionIncrement && data._version ?
      data._version :
      await this.nextVersion();
    const changeRecord: LocalChangeRecord = {
      _delta_id: syncId,
      _store: storeName,  // 确保这里存储的是原始store名称
      _version: version,
      type: operationType,
      originalId: data._delta_id
    };
    console.log(`记录变更：storeName=${storeName}, id=${data._delta_id}, version=${version}, operation=${operationType}`);
    await this.localAdapter.putBulk(this.LOCAL_CHANGES_STORE, [changeRecord]);
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
      const totalCount = await this.localAdapter.count(this.LOCAL_CHANGES_STORE);
      console.log(`获取本地变更记录总数: ${totalCount}`);
      if (totalCount === 0) {
        return 0;
      }
      const result = await this.localAdapter.read<LocalChangeRecord>(this.LOCAL_CHANGES_STORE, {
        offset: totalCount - 1,
        limit: 1
      });
      console.log(`获取最新一条变更记录: ${result.items[0]._version}`);
      if (result.items.length > 0 && result.items[0]._version !== undefined) {
        console.log(`获取当前版本号: ${result.items[0]._version} (共有${totalCount}条记录)`);
        return result.items[0]._version;
      }
      return 0;
    } catch (error) {
      console.warn("读取版本号失败:", error);
      return 0;
    }
  }


  async attachFile<T extends BaseModel>(
    model: T,
    file: File | Blob | ArrayBuffer,
    metadata: {
      filename: string,
      mimeType: string,
      metadata?: Record<string, any>
    }
  ): Promise<T> {
    const fileId = `attachment_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const fileItem: FileItem = {
      fileId: fileId,
      content: file
    };
    // 保存文件到存储
    const [savedAttachment] = await this.localAdapter.saveFiles([fileItem]);
    // 添加附件到模型
    if (!model._attachments) {
      model._attachments = [];
    }
    // 创建附件对象
    const attachment: Attachment = {
      id: savedAttachment.id,
      filename: metadata.filename,
      mimeType: metadata.mimeType,
      size: savedAttachment.size,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: metadata.metadata || {}
    };
    // 添加到模型
    model._attachments.push(attachment);
    return model;
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


  // 获取模型的所有附件内容
  async getAttachmentContents<T extends BaseModel>(
    model: T
  ): Promise<Map<string, { attachment: Attachment, content: Blob | ArrayBuffer | null }>> {
    if (!model._attachments || model._attachments.length === 0) {
      return new Map();
    }
    const attachmentIds = model._attachments.map(att => att.id);
    const contentsMap = await this.localAdapter.readFiles(attachmentIds);
    const result = new Map();
    for (const attachment of model._attachments) {
      const content = contentsMap.get(attachment.id);
      result.set(attachment.id, {
        attachment,
        content
      });
    }
    return result;
  }



  // 获取单个附件内容
  async getAttachmentContent<T extends BaseModel>(
    model: T,
    attachmentId: string
  ): Promise<{ attachment: Attachment, content: Blob | ArrayBuffer | null } | null> {
    if (!model._attachments) {
      return null;
    }
    // 找到附件
    const attachment = model._attachments.find(att => att.id === attachmentId);
    if (!attachment) {
      return null;
    }
    // 读取内容
    const contentsMap = await this.localAdapter.readFiles([attachmentId]);
    // 处理可能的 undefined 情况
    const content = contentsMap.get(attachmentId) || null;
    return { attachment, content };
  }


}
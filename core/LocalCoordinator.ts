// core/LocalCoordinator.ts
// 本地的协调层，包装数据库适配器同时提供自动化的变更记录


import {
  BaseModel,
  DatabaseAdapter,
  DataChange,
  SyncOperationType,
  FileItem,
  Attachment,
  AttachmentChange,
} from './types';
import { EncryptionConfig } from './SyncConfig'


export class LocalCoordinator {
  public localAdapter: DatabaseAdapter;
  private encryptionConfig?: EncryptionConfig;
  private readonly LOCAL_CHANGES_STORE = 'local_data_changes'; // 独立的变更表，记录所有数据修改
  private readonly ATTACHMENT_CHANGES_STORE = 'local_attachment_changes'; // 新增附件变更表


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
        await this.trackDataChange(
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
      const changes = items.map(item => ({
        _delta_id: item._delta_id,
        _version: item._version
      }));
      await Promise.all(changes.map(change =>
        this.trackDataChange(storeName, change, 'delete')
      ));
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
    await this.trackAttachmentChange(
      savedAttachment.id,
      model._version || 0,
      'put'
    );
    return attachment;
  }




  // 从模型中移除附件
  async detachFile(
    storeName: string,
    modelId: string,
    attachmentId: string
  ): Promise<BaseModel> {
    // 1. 首先获取原始模型
    const items = await this.localAdapter.readBulk<BaseModel>(storeName, [modelId]);
    if (items.length === 0) {
      throw new Error(`Cannot find model with ID ${modelId} in store ${storeName}`);
    }
    const model = items[0];
    if (!model._attachments) {
      throw new Error(`Model ${modelId} has no attachments`);
    }
    // 2. 查找附件
    const index = model._attachments.findIndex(att => att.id === attachmentId);
    if (index === -1) {
      throw new Error(`Attachment ${attachmentId} not found in model ${modelId}`);
    }
    try {
      // 3. 删除物理文件
      await this.localAdapter.deleteFiles([attachmentId]);
      // 4. 创建模型的副本并更新附件列表
      const updatedModel = {
        ...model,
        _attachments: [...model._attachments]
      };
      updatedModel._attachments.splice(index, 1);
      // 5. 保存更新后的模型，这将触发变更记录
      const [savedModel] = await this.putBulk(storeName, [updatedModel]);
      await this.trackAttachmentChange(
        attachmentId,
        savedModel._version || 0,
        'delete'
      );
      return savedModel;
    } catch (error) {
      console.error(`Error detaching file ${attachmentId} from model ${modelId}:`, error);
      throw error;
    }
  }


  // 记录附件变更
  private async trackAttachmentChange(
    attachmentId: string,      // 附件ID
    version: number,          // 版本号
    type: SyncOperationType,  // 操作类型
  ): Promise<void> {
    const attachmentChange: AttachmentChange = {
      _delta_id: attachmentId,
      _version: version,
      type: type,
    };
    await this.localAdapter.putBulk(
      this.ATTACHMENT_CHANGES_STORE,
      [attachmentChange]
    );
    console.log(
      `记录附件变更：attachmentId=${attachmentId}, ` +
      `version=${version}, ` +
      `type=${type}`
    );
  }


  // 记录变更，包括附件的变更
  private async trackDataChange<T extends BaseModel>(
    storeName: string,
    data: T,
    operationType: SyncOperationType
  ): Promise<void> {
    const syncId = data._delta_id;
    const version = await this.nextVersion();
    // 直接记录变更，不判断同步状态
    const changeRecord: DataChange<T> = {
      _delta_id: syncId,
      _store: storeName,
      _version: version,
      type: operationType,
      data: operationType === 'put' ? data : undefined,
    };
    await this.localAdapter.putBulk(this.LOCAL_CHANGES_STORE, [changeRecord]);
    console.log(
      `记录变更：storeName=${storeName}, ` +
      `id=${syncId}, ` +
      `version=${version}, ` +
      `operation=${operationType}`
    );
  }


  // 从云端同步数据
  async applyRemoteChange<T extends BaseModel>(changes: DataChange<T>[]): Promise<void> {
    const changesByStore = new Map<string, { puts: T[], deletes: string[] }>();
    // 1. 处理和分类变更
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
        storeChanges.deletes.push(change._delta_id);
      }
    }
    // 2. 应用数据变更
    for (const [storeName, storeChanges] of changesByStore.entries()) {
      if (storeChanges.puts.length > 0) {
        await this.localAdapter.putBulk(storeName, storeChanges.puts);
      }
      if (storeChanges.deletes.length > 0) {
        await this.localAdapter.deleteBulk(storeName, storeChanges.deletes);
      }
    }
    // 3. 保存所有变更记录（包括put和delete），并标记为已同步
    const markedChanges = changes.map(change => ({
      ...change,
      _synced: true // 标记所有变更记录为已同步
    }));
    await this.localAdapter.putBulk(this.LOCAL_CHANGES_STORE, markedChanges);
  }



  // 获取待同步的变更记录
  async getPendingChanges(since: number, limit: number = 100): Promise<DataChange[]> {
    const result = await this.localAdapter.readByVersion<DataChange>(
      this.LOCAL_CHANGES_STORE,
      {
        since: since,
        limit: limit,
        order: 'asc'
      }
    );
    return result.items;
  }



  // 获取待同步的附件变更
  async getPendingAttachmentChanges(since: number, limit: number = 100): Promise<AttachmentChange[]> {
    const result = await this.localAdapter.readByVersion<AttachmentChange>(
      this.ATTACHMENT_CHANGES_STORE,
      {
        since: since,
        limit: limit,
        order: 'asc'
      }
    );
    return result.items.sort((a, b) => (a._version || 0) - (b._version || 0));
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
      const result = await this.localAdapter.readByVersion<DataChange>(
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



  // 维护方法,清理旧的变更记录
  async performMaintenance(): Promise<void> {
    console.log("开始执行本地维护任务");
    let offset = 0;
    let hasMore = true;
    const batchSize = 1000;
    const recordsToDelete: string[] = [];
    // 分批处理所有变更记录
    while (hasMore) {
      const changesResult = await this.localAdapter.readByVersion<DataChange>(
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
          [change._delta_id]
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




}
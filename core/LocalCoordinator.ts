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

interface VersionState extends BaseModel {
  value: number;
}


export class LocalCoordinator {
  public localAdapter: DatabaseAdapter;
  private encryptionConfig?: EncryptionConfig;
  private readonly LOCAL_CHANGES_STORE = 'local_data_changes'; // 独立的变更表，记录所有数据修改
  private readonly ATTACHMENT_CHANGES_STORE = 'local_attachment_changes'; // 新增附件变更表
  private readonly META_STORE = 'local_meta'; // 改为更通用的meta存储表
  private readonly VERSION_KEY = 'sync_version'; // 修改key名使其更明确


  constructor(localAdapter: DatabaseAdapter, encryptionConfig?: EncryptionConfig) {
    this.localAdapter = localAdapter;
    this.encryptionConfig = encryptionConfig;
  }


  // 写入数据并自动跟踪变更
  async putBulk<T extends BaseModel>(
    storeName: string,
    items: T[],
    skipTracking: boolean = false
  ): Promise<T[]> {
    const updatedItems = items.map(item => ({
      ...item,
      _version: -1  // 新写入的数据版本号统一为-1
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


  // 记录数据变更
  private async trackDataChange<T extends BaseModel>(
    storeName: string,
    data: T,
    operationType: SyncOperationType
  ): Promise<void> {
    const syncId = data._delta_id;
    // 使用数字时间戳(毫秒)
    const timestamp = Date.now();
    const changeRecord: DataChange<T> = {
      _delta_id: syncId,
      _store: storeName,
      _version: timestamp,  // 使用数字时间戳
      type: operationType,
      data: operationType === 'put' ? data : undefined,
    };
    await this.localAdapter.putBulk(this.LOCAL_CHANGES_STORE, [changeRecord]);
    console.log(
      `记录待同步变更:
      - 存储: ${storeName}
      - ID: ${syncId}
      - 操作: ${operationType}
      - 时间: ${timestamp}`  // 日志中展示可读格式
    );
  }


  // 从云端同步数据
  async applyDataChange<T extends BaseModel>(changes: DataChange<T>[]): Promise<void> {
    const changesByStore = new Map<string, { puts: T[], deletes: string[] }>();
    for (const change of changes) {
      if (!changesByStore.has(change._store)) {
        changesByStore.set(change._store, { puts: [], deletes: [] });
      }
      const storeChanges = changesByStore.get(change._store)!;
      if (change.type === 'put' && change.data) {
        storeChanges.puts.push(change.data as T);
      } else if (change.type === 'delete') {
        storeChanges.deletes.push(change._delta_id);
      }
    }
    // 应用数据变更
    for (const [storeName, storeChanges] of changesByStore.entries()) {
      if (storeChanges.puts.length > 0) {
        await this.localAdapter.putBulk(storeName, storeChanges.puts);
      }
      if (storeChanges.deletes.length > 0) {
        await this.localAdapter.deleteBulk(storeName, storeChanges.deletes);
      }
    }
  }



  async applyAttachmentChanges(changes: AttachmentChange[]): Promise<void> {
    try {
      // 按照版本号排序
      const sortedChanges = [...changes].sort((a, b) =>
        (a._version || 0) - (b._version || 0)
      );
      // 记录成功处理的变更，以便后续更新状态
      const processedChanges: AttachmentChange[] = [];
      for (const change of sortedChanges) {
        try {
          // 标记为已同步
          const markedChange = {
            ...change,
            _synced: true
          };
          // 保存变更记录到本地附件变更表
          await this.localAdapter.putBulk(
            this.ATTACHMENT_CHANGES_STORE,
            [markedChange]
          );
          processedChanges.push(markedChange);
          console.log(
            `应用附件变更：attachmentId=${change._delta_id}, ` +
            `version=${change._version}, ` +
            `type=${change.type}`
          );
        } catch (error) {
          console.error(
            `处理附件变更失败: attachmentId=${change._delta_id}`,
            error
          );
        }
      }
    } catch (error) {
      console.error('应用附件变更时发生错误:', error);
      throw error;
    }
  }



  // 获取待同步的变更记录
  async getPendingChanges(since: number, limit: number = 100): Promise<DataChange[]> {
    try {
      const result = await this.localAdapter.readByVersion<DataChange>(
        this.LOCAL_CHANGES_STORE,
        {
          since: since, 
          limit,
          order: 'asc'
        }
      );
      return result.items;
    } catch (error) {
      console.error('获取待同步变更失败:', error);
      return [];
    }
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




  async updateCurrentVersion(timestamp: number): Promise<void> {
    try {
      if (!Number.isInteger(timestamp) || timestamp < 0) {
        throw new Error("时间戳必须是一个有效的正整数");
      }
      await this.localAdapter.putBulk(this.META_STORE, [{
        _delta_id: this.VERSION_KEY,
        value: timestamp
      }]);
      console.log(`成功更新同步时间戳: ${timestamp}`);
    } catch (error) {
      console.error("更新同步时间戳失败:", error);
      throw new Error(`更新同步时间戳失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }



  // 获取当前版本号(Todo优化查询方式)
  async getCurrentVersion(): Promise<number> {
    try {
      const result = await this.localAdapter.readBulk<VersionState>(
        this.META_STORE,
        [this.VERSION_KEY]
      );
      if (result.length > 0) {
        return result[0].value;
      }
      // 如果没有记录,初始化为0
      const initialState: VersionState = {
        _delta_id: this.VERSION_KEY,
        _version: -1,        // BaseModel要求的字段
        _store: this.META_STORE,  // BaseModel要求的字段
        value: 0
      };
      await this.localAdapter.putBulk(this.META_STORE, [initialState]);
      return 0;
    } catch (error) {
      console.warn("读取同步时间戳失败:", error);
      return 0;
    }
  }


}
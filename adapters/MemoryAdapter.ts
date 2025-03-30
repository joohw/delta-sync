// core/adapters/memory.ts
// 内存数据库适配器

import { DatabaseAdapter, BaseModel, Attachment } from '../core/types';

interface StoredFile {
  _delta_id: string;
  content: Blob | ArrayBuffer;
  metadata: Attachment;
  _created_at: number;
  _updated_at: number;
}

export class MemoryAdapter implements DatabaseAdapter {
  private stores: Map<string, Map<string, any>> = new Map();
  private fileStore: Map<string, StoredFile> = new Map();
  private fileStoreName: string = '_files';

  constructor() {
    // Initialize with empty stores
  }

  async isAvailable(): Promise<boolean> {
    return true; // Memory adapter is always available
  }


  async initSync(): Promise<void> {
    this.ensureStoreExists('_sync_change');
    this.ensureStoreExists('_sync_meta');
    this.ensureStoreExists(this.fileStoreName);
    return Promise.resolve();
  }


  private ensureStoreExists(storeName: string): void {
    if (!this.stores.has(storeName)) {
      this.stores.set(storeName, new Map());
    }
  }


  // 实现新的read方法，支持分页和since参数
  async readByVersion<T extends BaseModel>(
    storeName: string,
    options: {
      limit?: number;
      offset?: number;
      since?: number;
    } = {}
  ): Promise<{ items: T[]; hasMore: boolean }> {
    this.ensureStoreExists(storeName);
    const store = this.stores.get(storeName)!;
    // 获取所有记录
    let items = Array.from(store.values()) as T[];
    // 如果指定了since参数，则按时间戳筛选
    if (options.since) {
      items = items.filter(item => (item._version || 0) > options.since!);
    }
    // 按版本号排序
    items.sort((a, b) => (a._version || 0) - (b._version || 0));
    // 计算分页结果
    const offset = options.offset || 0;
    const limit = options.limit || items.length;
    const paginatedItems = items.slice(offset, offset + limit);
    const hasMore = offset + limit < items.length;
    return {
      items: paginatedItems,
      hasMore
    };
  }


  async readBulk<T extends BaseModel>(storeName: string, ids: string[]): Promise<T[]> {
    this.ensureStoreExists(storeName);
    const store = this.stores.get(storeName)!;
    const results: T[] = [];
    for (const id of ids) {
      const item = store.get(id);
      if (item !== undefined) {
        results.push(item as T);
      }
    }
    return results;
  }


  async putBulk<T extends BaseModel>(storeName: string, items: T[]): Promise<T[]> {
    this.ensureStoreExists(storeName);
    const store = this.stores.get(storeName)!;
    const now = Date.now();
    const processedItems = items.map(item => {
      const processedItem = {
        ...item,
        _ver: item._version || now,
        _store: storeName
      };
      store.set(processedItem._delta_id, processedItem);
      return processedItem;
    });
    return processedItems as T[];
  }


  // 批量删除接口
  async deleteBulk(storeName: string, ids: string[]): Promise<void> {
    this.ensureStoreExists(storeName);
    const store = this.stores.get(storeName)!;
    for (const id of ids) {
      store.delete(id);
    }
    return Promise.resolve();
  }


  // 文件操作实现
  async readFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>> {
    const result = new Map<string, Blob | ArrayBuffer | null>();
    // 快速批量查找
    for (const fileId of fileIds) {
      const file = this.fileStore.get(fileId);
      if (file) {
        result.set(fileId, file.content);
      } else {
        result.set(fileId, null);
      }
    }
    return result;
  }


  async saveFiles(files: Array<{ content: Blob | ArrayBuffer | string, fileId: string }>): Promise<Attachment[]> {
    if (files.length === 0) {
      return [];
    }
    const now = Date.now();
    const attachments = new Array<Attachment>(files.length);
    for (let i = 0; i < files.length; i++) {
      const { content, fileId } = files[i];
      let fileContent: Blob | ArrayBuffer;
      if (typeof content === 'string') {
        fileContent = new Blob([content], { type: 'text/plain' });
      } else {
        fileContent = content;
      }
      let fileName = fileId;
      let extension = '';
      const lastDotIndex = fileName.lastIndexOf('.');
      if (lastDotIndex !== -1) {
        extension = fileName.substring(lastDotIndex);
        fileName = fileName.substring(0, lastDotIndex);
      }
      const attachment: Attachment = {
        id: fileId,
        filename: fileName + extension,
        mimeType: fileContent instanceof Blob ? fileContent.type : 'application/octet-stream',
        size: fileContent instanceof Blob ? fileContent.size : fileContent.byteLength,
        createdAt: now,
        updatedAt: now,
        metadata: {}
      };
      // 存储文件
      this.fileStore.set(fileId, {
        _delta_id: fileId,
        content: fileContent,
        metadata: attachment,
        _created_at: now,
        _updated_at: now
      });
      attachments[i] = attachment;
    }
    return attachments;
  }


  async deleteFiles(fileIds: string[]): Promise<{ deleted: string[], failed: string[] }> {
    const result = {
      deleted: [] as string[],
      failed: [] as string[]
    };
    for (const fileId of fileIds) {
      if (this.fileStore.has(fileId)) {
        this.fileStore.delete(fileId);
        result.deleted.push(fileId);
      } else {
        result.failed.push(fileId);
      }
    }
    return result;
  }

  // 清空指定的store
  async clearStore(storeName: string): Promise<boolean> {
    try {
      if (!this.stores.has(storeName)) {
        return true;
      }
      this.stores.set(storeName, new Map());
      return true;
    } catch (error) {
      console.error(`清空store ${storeName}失败:`, error);
      return false;
    }
  }


  async count(storeName: string): Promise<number> {
    this.ensureStoreExists(storeName);
    const store = this.stores.get(storeName)!;
    return store.size;
  }


}
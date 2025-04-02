// core/adapters/memory.ts
import {
  DatabaseAdapter,
  Attachment,
  FileItem,
  DataItem
} from '../types';


interface StoredFile {
  id: string;
  content: Blob | ArrayBuffer;
  metadata: Attachment;
  createdAt: number;
  updatedAt: number;
}


export class MemoryAdapter implements DatabaseAdapter {
  private stores: Map<string, Map<string, any>>;
  private fileStore: Map<string, StoredFile>;
  private readonly MAX_STORE_SIZE = 10000; // 每个store的最大记录数

  constructor() {
    this.stores = new Map();
    this.fileStore = new Map();
  }

  /**
   * 检查存储是否可用
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * 读取指定store的数据，支持分页和版本过滤
   */
  async readStore<T>(
    storeName: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<{ items: T[]; hasMore: boolean }> {
    const store = this.getStore(storeName);
    let items = Array.from(store.values()) as T[];

    // 按创建时间排序
    items.sort((a: any, b: any) =>
      (b.createdAt || 0) - (a.createdAt || 0)
    );

    // 分页处理
    const pageLimit = Math.min(limit || 100, this.MAX_STORE_SIZE);
    const pageItems = items.slice(offset, offset + pageLimit);

    return {
      items: pageItems,
      hasMore: offset + pageLimit < items.length
    };
  }

  /**
   * 批量读取指定ID的数据
   */
  async readBulk<T>(storeName: string, ids: string[]): Promise<T[]> {
    const store = this.getStore(storeName);
    return ids
      .map(id => store.get(id))
      .filter(item => item !== undefined) as T[];
  }

  /**
   * 批量保存数据
   */
  async putBulk(storeName: string, items: DataItem[]): Promise<any[]> {
    if (!items.length) return [];

    const store = this.getStore(storeName);
    const now = Date.now();

    const results = items.map(item => {
      const existing = store.get(item.id);
      const version = now;

      const record = {
        ...item.data,
        id: item.id,
        version,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };

      store.set(item.id, record);
      return record;
    });

    // 检查store大小限制
    if (store.size > this.MAX_STORE_SIZE) {
      this.pruneStore(store);
    }

    return results;
  }

  /**
   * 批量删除数据
   */
  async deleteBulk(storeName: string, ids: string[]): Promise<void> {
    const store = this.getStore(storeName);
    ids.forEach(id => store.delete(id));
  }

  /**
   * 读取文件内容
   */
  async readFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>> {
    const results = new Map<string, Blob | ArrayBuffer | null>();

    fileIds.forEach(id => {
      const file = this.fileStore.get(id);
      results.set(id, file ? file.content : null);
    });

    return results;
  }

  /**
   * 保存文件
   */
  async saveFiles(files: FileItem[]): Promise<Attachment[]> {
    if (!files.length) return [];

    const now = Date.now();
    const results: Attachment[] = [];

    for (const file of files) {
      const fileContent = this.normalizeContent(file.content);
      const attachment: Attachment = {
        id: file.fileId,
        filename: file.fileId,
        mimeType: this.getMimeType(fileContent),
        size: this.getContentSize(fileContent),
        createdAt: now,
        updatedAt: now,
        metadata: {}
      };

      this.fileStore.set(file.fileId, {
        id: file.fileId,
        content: fileContent,
        metadata: attachment,
        createdAt: now,
        updatedAt: now
      });

      results.push(attachment);
    }

    return results;
  }

  /**
   * 删除文件
   */
  async deleteFiles(fileIds: string[]): Promise<{ deleted: string[], failed: string[] }> {
    const result = {
      deleted: [] as string[],
      failed: [] as string[]
    };

    fileIds.forEach(id => {
      if (this.fileStore.delete(id)) {
        result.deleted.push(id);
      } else {
        result.failed.push(id);
      }
    });

    return result;
  }

  /**
   * 清空store
   */
  async clearStore(storeName: string): Promise<boolean> {
    return this.stores.delete(storeName);
  }

  // 私有辅助方法
  private getStore(name: string): Map<string, any> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return store;
  }

  private pruneStore(store: Map<string, any>): void {
    // 删除最旧的记录直到达到大小限制
    const items = Array.from(store.entries());
    items.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));

    const toDelete = items.slice(0, items.length - this.MAX_STORE_SIZE);
    toDelete.forEach(([key]) => store.delete(key));
  }

  private normalizeContent(content: Blob | ArrayBuffer | string): Blob | ArrayBuffer {
    if (typeof content === 'string') {
      return new Blob([content], { type: 'text/plain' });
    }
    return content;
  }

  private getMimeType(content: Blob | ArrayBuffer): string {
    return content instanceof Blob ? content.type : 'application/octet-stream';
  }

  private getContentSize(content: Blob | ArrayBuffer): number {
    return content instanceof Blob ? content.size : content.byteLength;
  }
}

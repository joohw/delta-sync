// core/adapters/memory.ts
import {
  DatabaseAdapter,
  Attachment,
  FileItem
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
  private readonly MAX_STORE_SIZE = 10000;

  constructor() {
    this.stores = new Map();
    this.fileStore = new Map();
    this.stores.set('__delta_attachments__', new Map());
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async readStore<T extends { id: string }>(
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

  async readBulk<T extends { id: string }>(
    storeName: string, 
    ids: string[]
  ): Promise<T[]> {
    const store = this.getStore(storeName);
    return ids
      .map(id => store.get(id))
      .filter(item => item !== undefined) as T[];
  }

  async putBulk<T extends { id: string }>(
    storeName: string, 
    items: T[]
  ): Promise<T[]> {
    if (!items.length) return [];

    const store = this.getStore(storeName);
    const now = Date.now();

    const results = items.map(item => {
      const existing = store.get(item.id);
      
      const record = {
        ...item,
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

  async deleteBulk(storeName: string, ids: string[]): Promise<void> {
    const store = this.getStore(storeName);
    ids.forEach(id => store.delete(id));
  }

  async readFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>> {
    const results = new Map<string, Blob | ArrayBuffer | null>();

    fileIds.forEach(id => {
      const file = this.fileStore.get(id);
      results.set(id, file ? file.content : null);
    });

    return results;
  }

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

  async clearStore(storeName: string): Promise<boolean> {
    return this.stores.delete(storeName);
  }

  private getStore(name: string): Map<string, any> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return store;
  }

  private pruneStore(store: Map<string, any>): void {
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

  async getStores(): Promise<string[]> {
    return Array.from(this.stores.keys()).filter(
      store => !store.startsWith('__')
    );
  }
}

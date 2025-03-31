// core/adapters/memory.ts
import { DatabaseAdapter, DeltaModel, Attachment } from '../core/types';

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

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async readByVersion<T extends DeltaModel>(
    storeName: string,
    options: {
      limit?: number;
      offset?: number;
      since?: number;
      order?: 'asc' | 'desc';
    } = {}
  ): Promise<{ items: T[]; hasMore: boolean }> {
    const store = this.stores.get(storeName) || new Map();
    let items = Array.from(store.values()) as T[];
    if (options.since !== undefined) {
      items = items.filter(item => 
        options.order === 'desc' 
          ? (item._version || 0) < options.since!
          : (item._version || 0) > options.since!
      );
    }
    items.sort((a, b) => 
      options.order === 'desc'
        ? (b._version || 0) - (a._version || 0)
        : (a._version || 0) - (b._version || 0)
    );
    const offset = options.offset || 0;
    const limit = options.limit || items.length;
    const paginatedItems = items.slice(offset, offset + limit);
    return {
      items: paginatedItems,
      hasMore: offset + limit < items.length
    };
  }

  async readBulk<T extends DeltaModel>(storeName: string, ids: string[]): Promise<T[]> {
    const store = this.stores.get(storeName) || new Map();
    return ids
      .map(id => store.get(id))
      .filter(item => item !== undefined) as T[];
  }


  async putBulk<T extends DeltaModel>(storeName: string, items: T[]): Promise<T[]> {
    if (!items.length) return [];
    const store = this.stores.get(storeName) || new Map();
    this.stores.set(storeName, store);
    items.forEach(item => {
      store.set(item._delta_id, { ...item });
    });
    return [...items];
  }

  async deleteBulk(storeName: string, ids: string[]): Promise<void> {
    const store = this.stores.get(storeName);
    if (store) {
      ids.forEach(id => store.delete(id));
    }
  }


  async readFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>> {
    return new Map(
      fileIds.map(id => [
        id, 
        this.fileStore.get(id)?.content || null
      ])
    );
  }


  async saveFiles(files: Array<{ content: Blob | ArrayBuffer | string, fileId: string }>): Promise<Attachment[]> {
    if (!files.length) return [];
    const now = Date.now();
    return files.map(({ content, fileId }) => {
      const fileContent = typeof content === 'string' 
        ? new Blob([content], { type: 'text/plain' })
        : content;
      const attachment: Attachment = {
        id: fileId,
        filename: fileId,
        mimeType: fileContent instanceof Blob ? fileContent.type : 'application/octet-stream',
        size: fileContent instanceof Blob ? fileContent.size : fileContent.byteLength,
        createdAt: now,
        updatedAt: now,
        metadata: {}
      };
      this.fileStore.set(fileId, {
        _delta_id: fileId,
        content: fileContent,
        metadata: attachment,
        _created_at: now,
        _updated_at: now
      });
      return attachment;
    });
  }


  async deleteFiles(fileIds: string[]): Promise<{ deleted: string[], failed: string[] }> {
    return fileIds.reduce<{ deleted: string[], failed: string[] }>(
      (result, fileId) => {
        if (this.fileStore.delete(fileId)) {
          result.deleted.push(fileId);
        } else {
          result.failed.push(fileId);
        }
        return result;
      },
      { deleted: [], failed: [] }
    );
}

  async clearStore(storeName: string): Promise<boolean> {
    this.stores.delete(storeName);
    return true;
  }
}
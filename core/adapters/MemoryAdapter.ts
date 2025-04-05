// core/adapters/memory.ts
import { DatabaseAdapter } from '../types';



export class MemoryAdapter implements DatabaseAdapter {
  private stores: Map<string, Map<string, any>> = new Map();

  // validate store name is avaliable
  private validateStoreName(storeName: string): void {
    if (!storeName || typeof storeName !== 'string') {
      throw new Error('**Invalid store name**: Store name must be a non-empty string');
    }
  }


  // validate items is avaliable
  private validateItems<T extends { id: string }>(items: T[]): void {
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        throw new Error('**Invalid item**: Item must be an object');
      }
      if (!item.id || typeof item.id !== 'string') {
        throw new Error('**Invalid item**: Item must have a string id property');
      }
    }
  }

  // read data from memory store with pagination
  async readStore<T extends { id: string }>(
    storeName: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<{ items: T[]; hasMore: boolean }> {
    this.validateStoreName(storeName);
    const store = this.stores.get(storeName) || new Map();
    const allItems = Array.from(store.values()).sort((a, b) =>
      a.id.localeCompare(b.id)
    );
    const items = allItems.slice(offset, offset + limit) as T[];
    const hasMore = allItems.length > offset + limit;
    return { items, hasMore };
  }

  // read data from memory store with ids
  async readBulk<T extends { id: string }>(
    storeName: string,
    ids: string[]
  ): Promise<T[]> {
    this.validateStoreName(storeName);
    if (!Array.isArray(ids)) {
      throw new Error('**Invalid ids**: Must provide an array of ids');
    }
    const store = this.stores.get(storeName) || new Map();
    return ids.map(id => store.get(id)).filter(item => item !== undefined);
  }


  // write data to memory store
  async putBulk<T extends { id: string }>(
    storeName: string,
    items: T[]
  ): Promise<T[]> {
    this.validateStoreName(storeName);
    this.validateItems(items);
    if (!this.stores.has(storeName)) {
      this.stores.set(storeName, new Map());
    }
    const store = this.stores.get(storeName)!;
    for (const item of items) {
      store.set(item.id, item);
    }
    return items;
  }


  // delete data from memory store
  async deleteBulk(
    storeName: string,
    ids: string[]
  ): Promise<void> {
    this.validateStoreName(storeName);
    if (!Array.isArray(ids)) {
      throw new Error('**Invalid ids**: Must provide an array of ids');
    }
    const store = this.stores.get(storeName);
    if (store) {
      ids.forEach(id => store.delete(id));
    }
  }


  // clear data from memory store
  async clearStore(storeName: string): Promise<boolean> {
    this.validateStoreName(storeName);
    if (this.stores.has(storeName)) {
      this.stores.get(storeName)!.clear();
      return true;
    }
    return false;
  }

  // get all stores in memory
  async getStores(): Promise<string[]> {
    return Array.from(this.stores.keys());
  }

}

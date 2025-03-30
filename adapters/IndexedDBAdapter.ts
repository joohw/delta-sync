// adapters/indexeddb.ts
// 基于indexeddb的适配器

import { DatabaseAdapter, Attachment, BaseModel, FileItem } from '../core/types';

interface IndexedDBAdapterOptions {
    dbName?: string;
    fileStoreName?: string;
}

export class IndexedDBAdapter implements DatabaseAdapter {
    private db: IDBDatabase | null = null;
    private dbName: string;
    private initPromise: Promise<void> | null = null;
    private stores: Set<string> = new Set();
    private fileStoreName: string;

    constructor(options: IndexedDBAdapterOptions = {}) {
        this.dbName = options.dbName || 'deltaSyncDB';
        this.fileStoreName = options.fileStoreName || '_files'; // 默认文件存储名称
    }

    async isAvailable(): Promise<boolean> {
        return !!window.indexedDB;
    }

    async initSync(): Promise<void> {
        if (this.db) return;
        if (this.initPromise) return this.initPromise;
        this.initPromise = new Promise((resolve, reject) => {
            try {
                const request = indexedDB.open(this.dbName);
                request.onerror = () => {
                    reject(new Error(`Failed to open IndexedDB database: ${request.error?.message || 'Unknown error'}`));
                };
                request.onsuccess = () => {
                    this.db = request.result;
                    this.db.onversionchange = () => {
                        console.warn('Database version changed. Closing connection.');
                        this.db?.close();
                        this.db = null;
                        this.initPromise = null;
                    };
                    for (let i = 0; i < this.db.objectStoreNames.length; i++) {
                        this.stores.add(this.db.objectStoreNames[i]);
                    }
                    resolve();
                };
            } catch (error) {
                reject(new Error(`Failed to initialize IndexedDB: ${error instanceof Error ? error.message : String(error)}`));
            }
        });
        return this.initPromise;
    }


    private async ensureStore(storeName: string): Promise<void> {
        if (!this.db) {
            await this.initSync();
        }
        // 如果存储已经存在，直接返回
        if (this.stores.has(storeName)) {
            return;
        }
        if (!this.db!.objectStoreNames.contains(storeName)) {
            const currentVersion = this.db!.version;
            this.db!.close();
            this.db = null;
            this.initPromise = null;
            // 创建新连接并升级
            return new Promise<void>((resolve, reject) => {
                const request = indexedDB.open(this.dbName, currentVersion + 1);
                request.onerror = (event) => {
                    reject(new Error(`Failed to upgrade database for store: ${storeName}`));
                };
                request.onupgradeneeded = (event) => {
                    const db = request.result;
                    try {
                        const objectStore = db.createObjectStore(storeName, { keyPath: '_delta_id' });
                        objectStore.createIndex('_version', '_version', { unique: false });
                    } catch (error) {
                        console.error('Error creating store:', error);
                        request.transaction?.abort();
                        reject(error);
                    }
                };
                request.onsuccess = () => {
                    this.db = request.result;
                    this.stores.add(storeName);
                    this.db.onversionchange = () => {
                        this.db?.close();
                        this.db = null;
                        this.initPromise = null;
                        console.log('Database version changed by another connection');
                    };
                    resolve();
                };
            });
        } else {
            this.stores.add(storeName);
        }
    }


    // 读取指定版本之后的所有数据
    async readByVersion<T extends BaseModel>(
        storeName: string,
        options: {
            limit?: number;
            offset?: number;
            since?: number;
            order?: 'asc' | 'desc';
        } = {}
    ): Promise<{ items: T[]; hasMore: boolean }> {
        await this.ensureStore(storeName);
        const limit = options.limit || Number.MAX_SAFE_INTEGER;
        const offset = options.offset || 0;
        const since = options.since || 0;
        const order = options.order || 'asc';
        return new Promise<{ items: T[]; hasMore: boolean }>((resolve, reject) => {
            const transaction = this.db!.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const items: T[] = [];
            let skipped = 0;
            let processed = 0;
            let hasMore = false;
            try {
                // 获取索引
                const versionIndex = store.index('_version');
                let request: IDBRequest;
                // 根据排序顺序和是否有since参数决定如何打开游标
                if (order === 'desc') {
                    // 降序排列 - 从大到小
                    if (since > 0) {
                        // 如果指定了since，使用上界
                        const range = IDBKeyRange.upperBound(since, true);
                        request = versionIndex.openCursor(range, 'prev');
                    } else {
                        // 否则从最大值开始
                        request = versionIndex.openCursor(null, 'prev');
                    }
                } else {
                    // 升序排列 - 从小到大
                    if (since > 0) {
                        // 如果指定了since，使用下界
                        const range = IDBKeyRange.lowerBound(since, true);
                        request = versionIndex.openCursor(range);
                    } else {
                        // 否则从最小值开始
                        request = versionIndex.openCursor();
                    }
                }
                request.onerror = (event) => {
                    console.error(`索引查询失败: ${(event.target as IDBRequest).error}`);
                    this.fallbackReadByVersion(store, since, offset, limit, order, resolve, reject);
                };
                request.onsuccess = (event) => {
                    const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;
                    if (cursor) {
                        if (skipped < offset) {
                            skipped++;
                            cursor.continue();
                        } else if (processed < limit) {
                            items.push(cursor.value as T);
                            processed++;
                            cursor.continue();
                        } else {
                            hasMore = true;
                            resolve({ items, hasMore });
                        }
                    } else {
                        resolve({ items, hasMore });
                    }
                };
            } catch (error) {
                console.warn(`索引方法初始化失败，回退到标准方法: ${error}`);
                this.fallbackReadByVersion(store, since, offset, limit, order, resolve, reject);
            }
        });
    }


    async readBulk<T extends BaseModel>(storeName: string, ids: string[]): Promise<T[]> {
        await this.ensureStore(storeName);
        const transaction = this.db!.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const promises = ids.map(id =>
            new Promise<T | undefined>((resolve) => {
                const request = store.get(id);
                request.onsuccess = () => resolve(request.result as T);
                request.onerror = () => {
                    console.error(`Failed to read ${id} from ${storeName}`);
                    resolve(undefined);
                };
            })
        );
        const results = await Promise.all(promises);
        return results.filter(result => result !== undefined) as T[];
    }


    async putBulk<T extends BaseModel>(storeName: string, items: T[]): Promise<T[]> {
        if (!items.length) return [];
        await this.ensureStore(storeName);
        return new Promise<T[]>((resolve, reject) => {
            const transaction = this.db!.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const itemsWithMeta = items.map(item => {
                return {
                    ...item,
                };
            });
            // 批量保存所有项目
            itemsWithMeta.forEach(item => {
                store.put(item);
            });
            transaction.oncomplete = () => resolve(itemsWithMeta as T[]);
            transaction.onerror = () => reject(new Error(`Failed to put items in ${storeName}`));
        });
    }


    async deleteBulk(storeName: string, ids: string[]): Promise<void> {
        if (!ids.length) return;
        await this.ensureStore(storeName);
        return new Promise<void>((resolve, reject) => {
            const transaction = this.db!.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            ids.forEach(id => {
                store.delete(id);
            });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(new Error(`Failed to delete items from ${storeName}`));
        });
    }


    // 如果数据库未初始化或者store不存在，视为清空成功
    async clearStore(storeName: string): Promise<boolean> {
        if (!this.db || !this.db.objectStoreNames.contains(storeName)) {
            return true;
        }
        try {
            await new Promise<void>((resolve, reject) => {
                const transaction = this.db!.transaction(storeName, 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.clear();
                request.onsuccess = () => resolve();
                request.onerror = (event) => {
                    console.error(`清空store ${storeName}失败:`, event);
                    reject(new Error(`Failed to clear store ${storeName}`));
                };
                // 增加事务完成的错误处理
                transaction.oncomplete = () => resolve();
                transaction.onerror = (event) => {
                    console.error(`清空store ${storeName}的事务失败:`, event);
                    reject(new Error(`Transaction failed when clearing store ${storeName}`));
                };
            });
            return true; // 操作成功
        } catch (error) {
            console.error(`清空store ${storeName}时出错:`, error);
            return false; // 操作失败
        }
    }


    async readFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>> {
        if (!fileIds.length) return new Map();
        await this.ensureFileStore();
        const result = new Map<string, Blob | ArrayBuffer | null>();
        try {
            const transaction = this.db!.transaction(this.fileStoreName, 'readonly');
            const store = transaction.objectStore(this.fileStoreName);
            const promises = fileIds.map(async (fileId) => {
                return new Promise<void>((resolve) => {
                    const request = store.get(fileId);
                    request.onerror = () => {
                        console.warn(`Failed to read file: ${fileId} - ${request.error?.message || 'Unknown error'}`);
                        result.set(fileId, null);
                        resolve();
                    };
                    request.onsuccess = () => {
                        const fileObject = request.result;
                        if (!fileObject || !fileObject.content) {
                            result.set(fileId, null);
                        } else {
                            result.set(fileId, fileObject.content);
                        }
                        resolve();
                    };
                });
            });
            await Promise.all(promises);
            return result;
        } catch (error) {
            console.error('Batch file read error:', error);
            for (const fileId of fileIds) {
                if (!result.has(fileId)) {
                    result.set(fileId, null);
                }
            }
            return result;
        }
    }



    async saveFiles(files: FileItem[]): Promise<Attachment[]> {
        if (!files.length) return [];
        await this.ensureFileStore();
        const attachments: Attachment[] = [];
        try {
            const transaction = this.db!.transaction(this.fileStoreName, 'readwrite');
            const store = transaction.objectStore(this.fileStoreName);
            const now = Date.now();
            const promises = files.map(async (file) => {
                return new Promise<void>((resolve) => {
                    try {
                        const fileContent = file.content;
                        const fileId = file.fileId;
                        // 处理文件名和扩展名
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
                            size: fileContent instanceof Blob ? fileContent.size :
                                (fileContent instanceof ArrayBuffer ? fileContent.byteLength :
                                    String(fileContent).length),
                            createdAt: now,
                            updatedAt: now,
                            metadata: {}
                        };
                        const fileObject = {
                            _delta_id: fileId,
                            content: fileContent,
                            createdAt: now,
                            updatedAt: now
                        };
                        const request = store.put(fileObject);
                        request.onerror = () => {
                            console.error(`Failed to save file: ${fileId} - ${request.error?.message || 'Unknown error'}`);
                            resolve();
                        };
                        request.onsuccess = () => {
                            attachments.push(attachment);
                            resolve();
                        };
                    } catch (error) {
                        console.error('Error saving individual file:', error);
                        resolve();
                    }
                });
            });
            await Promise.all(promises);
            return attachments;
        } catch (error) {
            console.error('Batch file save error:', error);
            return attachments;
        }
    }


    async deleteFiles(fileIds: string[]): Promise<{ deleted: string[], failed: string[] }> {
        await this.ensureFileStore();
        const result = { deleted: [] as string[], failed: [] as string[] };
        try {
            const transaction = this.db!.transaction(this.fileStoreName, 'readwrite');
            const store = transaction.objectStore(this.fileStoreName);
            await Promise.all(fileIds.map(async (fileId) => {
                try {
                    await new Promise<void>((resolve, reject) => {
                        const getRequest = store.get(fileId);
                        getRequest.onsuccess = () => {
                            if (getRequest.result) {
                                const deleteRequest = store.delete(fileId);
                                deleteRequest.onsuccess = () => {
                                    result.deleted.push(fileId);
                                    resolve();
                                };
                                deleteRequest.onerror = () => {
                                    result.failed.push(fileId);
                                    resolve();
                                };
                            } else {
                                result.failed.push(fileId);
                                resolve();
                            }
                        };
                        getRequest.onerror = () => {
                            result.failed.push(fileId);
                            resolve();
                        };
                    });
                } catch (error) {
                    console.error(`Error deleting file ${fileId}:`, error);
                    result.failed.push(fileId);
                }
            }));
            return result;
        } catch (error) {
            console.error('Batch file delete error:', error);
            return result;
        }
    }


    private async ensureFileStore(): Promise<void> {
        await this.ensureStore(this.fileStoreName);
    }

    async close(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.initPromise = null;
        }
    }

    async deleteDatabase(): Promise<void> {
        await this.close();

        return new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(this.dbName);

            request.onsuccess = () => {
                this.stores.clear();
                resolve();
            };

            request.onerror = () => reject(new Error(`Failed to delete database ${this.dbName}`));
        });
    }


    // 提取回退方法以减少代码重复
    private fallbackReadByVersion<T extends BaseModel>(
        store: IDBObjectStore,
        since: number,
        offset: number,
        limit: number,
        order: 'asc' | 'desc',
        resolve: (value: { items: T[]; hasMore: boolean }) => void,
        reject: (reason?: any) => void
    ): void {
        const items: T[] = [];
        let skipped = 0;
        let processed = 0;
        let hasMore = false;
        // 使用标准方法打开游标
        const request = store.openCursor();
        // 如果需要降序，先收集所有符合条件的项，再排序
        if (order === 'desc') {
            const allItems: T[] = [];
            request.onerror = () => {
                reject(new Error(`Failed to read data from store`));
            };
            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;
                if (cursor) {
                    const item = cursor.value as T;
                    const itemVersion = (item as any)._version || 0;
                    // 如果没有since条件或者版本号小于since (降序时需要小于)
                    if (!since || itemVersion < since) {
                        allItems.push(item);
                    }
                    cursor.continue();
                } else {
                    // 完成数据收集后按版本号排序
                    allItems.sort((a, b) => ((b as any)._version || 0) - ((a as any)._version || 0));
                    // 应用offset和limit
                    for (let i = offset; i < allItems.length && processed < limit; i++) {
                        items.push(allItems[i]);
                        processed++;
                    }

                    hasMore = allItems.length > offset + limit;
                    resolve({ items, hasMore });
                }
            };
        } else {
            // 升序处理方式
            request.onerror = () => {
                reject(new Error(`Failed to read data from store`));
            };
            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;
                if (cursor) {
                    const item = cursor.value as T;
                    const itemVersion = (item as any)._version || 0;
                    if (!since || itemVersion > since) {
                        if (skipped < offset) {
                            skipped++;
                        } else if (processed < limit) {
                            items.push(item);
                            processed++;
                        } else {
                            hasMore = true;
                            resolve({ items, hasMore });
                            return;
                        }
                    }
                    cursor.continue();
                } else {
                    resolve({ items, hasMore });
                }
            };
        }
    }
}
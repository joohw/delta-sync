// adapters/indexeddb.ts
// 基于indexeddb的适配器

import { DatabaseAdapter, Attachment, BaseModel, FileItem, QueryOptions } from '../core/types';

interface IndexedDBAdapterOptions {
    dbName?: string;
    fileStoreName?: string;
}


export class IndexedDBAdapter implements DatabaseAdapter {

    // 添加表名常量
    private readonly LOCAL_CHANGES_STORE = 'local_data_changes';           
    private readonly ATTACHMENT_CHANGES_STORE = 'local_attachment_changes'; 
    private readonly META_STORE = 'local_meta';                           // 新增meta表
    private readonly FILES_STORE = '_files';

    private db: IDBDatabase | null = null;
    private dbName: string;
    private initPromise: Promise<void> | null = null;
    private stores: Set<string> = new Set();

    constructor(options: IndexedDBAdapterOptions = {}) {
        this.dbName = options.dbName || 'deltaSyncDB';
    }

    // 文件存储表


    async isAvailable(): Promise<boolean> {
        return !!window.indexedDB;
    }


    async initSync(): Promise<void> {
        if (this.db) return;
        if (this.initPromise) return this.initPromise;
        const currentVersion = await this.getCurrentDatabaseVersion();
        this.initPromise = new Promise((resolve, reject) => {
            try {
                // 使用当前版本打开
                const request = indexedDB.open(this.dbName, currentVersion);
                request.onupgradeneeded = (event) => {
                    const db = request.result;
                    this.createRequiredStores(db, event.oldVersion);
                };
                request.onerror = () => {
                    reject(new Error(`Failed to open IndexedDB database: ${request.error?.message || 'Unknown error'}`));
                };
                request.onsuccess = () => {
                    this.db = request.result;
                    // 检查是否需要升级以创建新存储
                    if (!this.db.objectStoreNames.contains(this.FILES_STORE) ||
                        !this.db.objectStoreNames.contains(this.LOCAL_CHANGES_STORE) ||
                        !this.db.objectStoreNames.contains(this.ATTACHMENT_CHANGES_STORE)) {
                        // 需要升级，关闭连接并重新打开
                        const newVersion = currentVersion + 1;
                        this.db.close();
                        const upgradeRequest = indexedDB.open(this.dbName, newVersion);
                        upgradeRequest.onupgradeneeded = (event) => {
                            const db = upgradeRequest.result;
                            this.createRequiredStores(db, event.oldVersion);
                        };
                        upgradeRequest.onerror = () => {
                            reject(new Error(`Failed to upgrade IndexedDB database: ${upgradeRequest.error?.message || 'Unknown error'}`));
                        };
                        upgradeRequest.onsuccess = () => {
                            this.db = upgradeRequest.result;
                            this.setupDbConnection();
                            resolve();
                        };
                    } else {
                        this.setupDbConnection();
                        resolve();
                    }
                };
            } catch (error) {
                reject(new Error(`Failed to initialize IndexedDB: ${error instanceof Error ? error.message : String(error)}`));
            }
        });
        return this.initPromise;
    }


    // 获取当前数据库版本
    private async getCurrentDatabaseVersion(): Promise<number> {
        return new Promise((resolve) => {
            const request = indexedDB.open(this.dbName);
            request.onsuccess = () => {
                const version = request.result.version;
                request.result.close();
                resolve(version);
            };
            request.onerror = () => {
                // 如果数据库不存在，返回版本1
                resolve(1);
            };
        });
    }


    // 设置数据库连接
    private setupDbConnection(): void {
        this.db!.onversionchange = () => {
            console.warn('Database version changed. Closing connection.');
            this.db?.close();
            this.db = null;
            this.initPromise = null;
        };
        this.stores.clear();
        for (let i = 0; i < this.db!.objectStoreNames.length; i++) {
            this.stores.add(this.db!.objectStoreNames[i]);
        }
    }


    // 创建必要的存储
    private createRequiredStores(db: IDBDatabase, oldVersion: number): void {
        // 创建meta存储，用于存储各种元数据
        if (!db.objectStoreNames.contains(this.META_STORE)) {
            const metaStore = db.createObjectStore(this.META_STORE, { 
                keyPath: '_delta_id'  // 使用_delta_id作为主键
            });
            // 为meta表创建必要的索引
            metaStore.createIndex('_version', '_version', { unique: false });
            metaStore.createIndex('type', 'type', { unique: false });
            metaStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        // 创建文件存储
        if (!db.objectStoreNames.contains(this.FILES_STORE)) {
            const fileStore = db.createObjectStore(this.FILES_STORE, { 
                keyPath: '_delta_id' 
            });
            fileStore.createIndex('createdAt', 'createdAt', { unique: false });
            fileStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        // 创建数据变更记录存储
        if (!db.objectStoreNames.contains(this.LOCAL_CHANGES_STORE)) {
            const dataChangesStore = db.createObjectStore(this.LOCAL_CHANGES_STORE, { 
                keyPath: '_delta_id' 
            });
            dataChangesStore.createIndex('_version', '_version', { unique: false });
        }
        // 创建附件变更记录存储
        if (!db.objectStoreNames.contains(this.ATTACHMENT_CHANGES_STORE)) {
            const attachmentChangesStore = db.createObjectStore(this.ATTACHMENT_CHANGES_STORE, { 
                keyPath: '_delta_id' 
            });
            attachmentChangesStore.createIndex('_version', '_version', { unique: false });
        }
        // 创建笔记存储
        if (!db.objectStoreNames.contains('notes')) {
            const noteStore = db.createObjectStore('notes', { 
                keyPath: '_delta_id' 
            });
            noteStore.createIndex('_version', '_version', { unique: false });
        }
    }
    


    private async ensureStore(storeName: string): Promise<void> {
        if (!this.db) {
            await this.initSync();
        }
        if (this.stores.has(storeName)) {
            return;
        }
    }


    // 读取指定版本之后的所有数据
    async readByVersion<T extends BaseModel>(
        storeName: string,
        options: QueryOptions,
    ): Promise<{ items: T[]; hasMore: boolean }> {
        await this.ensureStore(storeName);
        const limit = options.limit || Number.MAX_SAFE_INTEGER;
        const offset = options.offset || 0;
        const since = options.since || 0;
        const order = options.order || 'asc';
        return new Promise<{ items: T[]; hasMore: boolean }>((resolve, reject) => {
            try {
                const transaction = this.db!.transaction(storeName, 'readonly');
                const store = transaction.objectStore(storeName);
                const versionIndex = store.index('_version');
                const items: T[] = [];
                let skipped = 0;
                let processed = 0;
                let hasMore = false;
                let request: IDBRequest;
                // 根据排序顺序和since参数决定游标打开方式
                if (order === 'desc') {
                    // 降序时，查找小于等于 since 的记录
                    const range = since > 0 ? IDBKeyRange.upperBound(since) : null;
                    request = versionIndex.openCursor(range, 'prev');
                } else {
                    // 升序时，查找大于等于 since 的记录
                    const range = since > 0 ? IDBKeyRange.lowerBound(since) : null;
                    request = versionIndex.openCursor(range);
                }
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
                request.onerror = (event) => {
                    reject(new Error(`查询${storeName}时出错: ${(event.target as IDBRequest).error}`));
                };
                transaction.onerror = (event) => {
                    reject(new Error(`事务执行出错: ${transaction.error}`));
                };
            } catch (error) {
                reject(new Error(`执行查询时发生错误: ${error instanceof Error ? error.message : String(error)}`));
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
            const transaction = this.db!.transaction(this.FILES_STORE, 'readonly');
            const store = transaction.objectStore(this.FILES_STORE);
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
            const transaction = this.db!.transaction(this.FILES_STORE, 'readwrite');
            const store = transaction.objectStore(this.FILES_STORE);
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
            const transaction = this.db!.transaction(this.FILES_STORE, 'readwrite');
            const store = transaction.objectStore(this.FILES_STORE);
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
        await this.ensureStore(this.FILES_STORE);
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


}
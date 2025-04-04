// core/types.ts

export type SyncOperationType = 'put' | 'delete';


export interface SyncQueryOptions {
    since?: number;      // 查询某个_ver之后的数据
    limit?: number;      // 限制返回数量
    offset?: number;     // 起始位置
}


export interface SyncQueryResult<T = any> {
    items: T[];
    hasMore: boolean;
}


export interface SyncProgress {
    processed: number;
    total: number;
}


// 返回的同步请求模型
export interface SyncResult {
    success: boolean;
    error?: string;
    syncedAt?: number;
    stats?: {
        uploaded: number;
        downloaded: number;
        errors: number;
    };
}


// Synchronization status enumeration
export enum SyncStatus {
    ERROR = -2,        // Error status
    OFFLINE = -1,      // Offline status
    IDLE = 0,         // Idle status
    UPLOADING = 1,    // Upload synchronization in progress
    DOWNLOADING = 2,  // Download synchronization in progress
    OPERATING = 3,    // Operation in progress (clearing notes and other special operations)
}


export interface SyncOptions<T extends { id: string } = any> {
    autoSync?: {
        enabled?: boolean;
        pullInterval?: number;
        pushDebounce?: number;
        retryDelay?: number;
    };
    onStatusUpdate?: (status: SyncStatus) => void;
    onVersionUpdate?: (_ver: number) => void;
    onChangePushed?: (changes: DataChangeSet) => void;
    onChangePulled?: (changes: DataChangeSet) => void;
    maxRetries?: number;    // 最大重试次数
    timeout?: number;       // 超时时间(毫秒)
    batchSize?: number;     // 同步批次的数量
    payloadSize?: number;   // 传输的对象最大大小(字节)
    maxFileSize?: number;   // 最大支持的文件大小(字节)
    fileChunkSize?: number; // 文件分块存储的单块大小(字节)
}


export interface SyncViewItem {
    id: string;
    store: string;
    _ver: number;
    deleted?: boolean;      // 标记是否被删除
    isAttachment?: boolean; // 标记是否为附件
}


export interface DataChange<T = any> {
    id: string;
    data?: T;
    _ver: number;
}


export interface DataChangeSet {
    delete: Map<string, DataChange[]>; // store -> changes
    put: Map<string, DataChange[]>;    // store -> changes
}


export class SyncView {
    private items: Map<string, SyncViewItem>;
    private storeIndex: Map<string, Set<string>>;
    constructor() {
        this.items = new Map();
        this.storeIndex = new Map();
    }
    // 添加或更新记录
    upsert(item: SyncViewItem): void {
        const key = this.getKey(item.store, item.id);
        this.items.set(key, item);
        if (!this.storeIndex.has(item.store)) {
            this.storeIndex.set(item.store, new Set());
        }
        this.storeIndex.get(item.store)!.add(item.id);
    }
    // 批量更新
    upsertBatch(items: SyncViewItem[]): void {
        for (const item of items) {
            this.upsert(item);
        }
    }
    // 获取特定记录
    get(store: string, id: string): SyncViewItem | undefined {
        return this.items.get(this.getKey(store, id));
    }
    // 分页获取指定 store 的所有记录
    getByStore(store: string, offset: number = 0, limit: number = 100): SyncViewItem[] {
        const storeItems = this.storeIndex.get(store);
        if (!storeItems) return [];
        return Array.from(storeItems)
            .slice(offset, offset + limit)
            .map(id => this.items.get(this.getKey(store, id))!)
            .filter(item => item !== undefined);
    }
    // 获取所有 store 的名称
    getStores(): string[] {
        return Array.from(this.storeIndex.keys())
    }
    // 比较两个视图的差异
    static diffViews(local: SyncView, remote: SyncView): {
        toDownload: SyncViewItem[];
        toUpload: SyncViewItem[];
    } {
        const toDownload: SyncViewItem[] = [];
        const toUpload: SyncViewItem[] = [];
        const localKeys = new Set(local.items.keys());
        const remoteKeys = new Set(remote.items.keys());
        // 仅本地存在的键（需要上传）
        for (const key of localKeys) {
            if (!remoteKeys.has(key)) {
                toUpload.push(local.items.get(key)!);
            }
        }
        // 仅远程存在的键（需要下载）
        for (const key of remoteKeys) {
            if (!localKeys.has(key)) {
                toDownload.push(remote.items.get(key)!);
            }
        }
        // 共同存在的键（需要比对版本）
        for (const key of localKeys) {
            if (remoteKeys.has(key)) {
                const localItem = local.items.get(key)!;
                const remoteItem = remote.items.get(key)!;
                if (localItem._ver > remoteItem._ver) {
                    toUpload.push(localItem);
                } else if (localItem._ver < remoteItem._ver) {
                    toDownload.push(remoteItem);
                }
            }
        }
        return { toDownload, toUpload };
    }


    // 生成复合键
    private getKey(store: string, id: string): string {
        return `${store}:${id}`;
    }
    // 删除记录
    delete(store: string, id: string): void {
        const key = this.getKey(store, id);
        this.items.delete(key);
        this.storeIndex.get(store)?.delete(id);
    }
    // 获取存储大小
    size(): number {
        return this.items.size;
    }
    // 获取特定 store 的记录数量
    storeSize(store: string): number {
        return this.storeIndex.get(store)?.size || 0;
    }
    // 清除所有数据
    clear(): void {
        this.items.clear();
        this.storeIndex.clear();
    }
    // 序列化视图数据（用于持久化）
    serialize(): string {
        return JSON.stringify(Array.from(this.items.values()));
    }
    // 从序列化数据恢复（用于持久化）
    static deserialize(data: string): SyncView {
        const view = new SyncView();
        const items = JSON.parse(data) as SyncViewItem[];
        view.upsertBatch(items);
        return view;
    }
}



// 数据库适配器,支持任意类型的数据库
export interface DatabaseAdapter {
    readStore<T extends { id: string }>(
        storeName: string,
        limit?: number,
        offset?: number
    ): Promise<{ items: T[]; hasMore: boolean }>;
    readBulk<T extends { id: string }>(
        storeName: string,
        ids: string[]
    ): Promise<T[]>;
    putBulk<T extends { id: string }>(
        storeName: string,
        items: T[]
    ): Promise<T[]>;
    deleteBulk(storeName: string, ids: string[]): Promise<void>;
    clearStore(storeName: string): Promise<boolean>;
    getStores(): Promise<string[]>;
}




// 本地协调器接口定义
export interface ICoordinator {
    // 生命周期方法
    initSync?: () => Promise<void>;     // 可选：初始化时执行
    disposeSync?: () => Promise<void>;  // 可选：卸载时执行
    // 核心数据操作方法
    query<T extends { id: string }>(
        storeName: string,
        options?: SyncQueryOptions
    ): Promise<SyncQueryResult<T>>;
    // 同步视图相关
    getCurrentView(): Promise<SyncView>;
    // 批量数据操作
    readBulk<T extends { id: string }>(
        storeName: string,
        ids: string[]
    ): Promise<T[]>;
    putBulk<T extends { id: string }>(
        storeName: string,
        items: T[],
        silent?: boolean
    ): Promise<T[]>;
    deleteBulk(
        storeName: string,
        ids: string[]
    ): Promise<void>;
    onDataChanged(callback: () => void): void;
    extractChanges(items: SyncViewItem[]): Promise<DataChangeSet>;
    applyChanges(changeSet: DataChangeSet): Promise<void>;
}




export interface ISyncEngine {
    // 初始化
    initialize(): Promise<void>;
    // 自动同步控制
    enableAutoSync(interval?: number): void;
    disableAutoSync(): void;
    updateSyncOptions(options: Partial<SyncOptions>): SyncOptions;
    // 云端适配器设置
    setCloudAdapter(cloudAdapter: DatabaseAdapter): Promise<void>;
    save<T extends { id: string }>(
        storeName: string,
        data: T | T[]
    ): Promise<T[]>
    delete(storeName: string, ids: string | string[]): Promise<void>;
    sync(): Promise<SyncResult>;
    push(): Promise<SyncResult>;
    pull(): Promise<SyncResult>;
    query<T extends { id: string }>(
        storeName: string,
        options?: SyncQueryOptions
    ): Promise<SyncQueryResult<T>>;
    clearCloudStores(strings: string | string[]): Promise<void>;
    getlocalCoordinator(): Promise<ICoordinator>;
    getlocalAdapter(): Promise<DatabaseAdapter>;
    getCloudAdapter(): Promise<DatabaseAdapter | undefined>;
    dispose(): void;
    disconnectCloud(): void;
}
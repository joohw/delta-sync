// core/types.ts

export type SyncOperationType = 'put' | 'delete';


export interface Attachment {
    id: string;               // 附件的唯一标识符，指向二进制数据
    filename: string;         // 文件名
    mimeType: string;         // MIME类型
    size: number;             // 文件大小(字节)
    createdAt: number;        // 创建时间
    updatedAt: number;        // 更新时间
    metadata: Record<string, any>;  // 元数据
    missingAt?: number; // 对应的附件已经被标记为缺失
}


export interface FileItem {
    fileId: string,  // 文件在存储的唯一键，与Attachment.id对应
    content: Blob | ArrayBuffer | string,  // 文件的二进制数据
}

export interface DataItem {
    id: string;
    data: any;
}


export interface SyncQueryOptions {
    since?: number;      // 查询某个version之后的数据
    limit?: number;      // 限制返回数量
    offset?: number;     // 起始位置
    order?: 'asc' | 'desc';  // 排序顺序
}


export interface SyncQueryResult<T = any> {
    items: T[];
    hasMore: boolean;
}


// 数据在本地协调层以DeltaModel的形式存储
export interface DeltaModel<T = any> {
    id: string;  // 用于同步的唯一标识符（主键）
    store: string// 所属表名，这个数值不应该被修改
    data: T  //数据实体的最新的完整数据
    version: number; // 版本号
}


// 包含完整数据的变更记录
export interface DataChange<T = any> {
    id: string;      // 数据实体本身的唯一标识符,由store+原始数据的id计算
    store: string;
    data: T;
    version: number;
    operation: SyncOperationType;
}


export interface SyncViewItem {
    id: string;
    store: string;
    version: number;
    deleted?: boolean;      // 标记是否被删除
    revisionCount?: number;  // 修订版本数量
    isAttachment?: boolean; // 标记是否为附件
}


export class SyncView {
    private static readonly ATTACHMENT_STORE = '__delta_attachments__';
    private items: Map<string, SyncViewItem>;
    private storeIndex: Map<string, Set<string>>; // store -> itemIds 的索引
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
        return Array.from(this.storeIndex.keys()).filter(
            store => store !== SyncView.ATTACHMENT_STORE
        );
    }


    // 比较两个视图的差异
    static diffViews(local: SyncView, remote: SyncView): {
        toDownload: SyncViewItem[];
        toUpload: SyncViewItem[];
    } {
        const toDownload: SyncViewItem[] = [];
        const toUpload: SyncViewItem[] = [];
        // 检查所有本地记录
        for (const [key, localItem] of local.items) {
            const remoteItem = remote.items.get(key);
            if (!remoteItem) {
                // 远端没有，需要上传
                toUpload.push(localItem);
            } else if (localItem.version > remoteItem.version) {
                // 本地版本更新，需要上传
                toUpload.push(localItem);
            } else if (localItem.version < remoteItem.version) {
                // 远端版本更新，需要下载
                toDownload.push(remoteItem);
            }
        }
        // 检查远端独有的记录
        for (const [key, remoteItem] of remote.items) {
            if (!local.items.has(key)) {
                // 本地没有，需要下载
                toDownload.push(remoteItem);
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


    // 针对附件的特殊处理
    upsertAttachment(attachment: Attachment): void {
        this.upsert({
            id: attachment.id,
            store: SyncView.ATTACHMENT_STORE,
            version: attachment.updatedAt,
            isAttachment: true
        });
    }

    getAttachments(offset: number = 0, limit: number = 100): SyncViewItem[] {
        return this.getByStore(SyncView.ATTACHMENT_STORE, offset, limit);
    }

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


export interface SyncOptions {
    autoSync?: {
        enabled?: boolean;
        interval?: number;
        retryDelay?: number;
    };
    onStatusUpdate?: (status: SyncStatus) => void;
    onVersionUpdate?: (version: number) => void;
    onChangePulled?: (changes: DataChange[]) => void;
    onChangePushed?: (changes: DataChange[]) => void;
    maxRetries?: number;    // 最大重试次数
    timeout?: number;       // 超时时间(毫秒)
    batchSize?: number;     // 同步批次的数量
    payloadSize?: number;   // 传输的对象最大大小(字节)
    maxFileSize?: number;   // 最大支持的文件大小(字节)
    fileChunkSize?: number; // 文件分块存储的单块大小(字节)
}




// 数据库适配器,支持任意类型的数据库
export interface DatabaseAdapter {
    readStore<T>(storeName: string, limit?: number, offset?: number): Promise<{ items: T[]; hasMore: boolean }>;
    readBulk<T extends DeltaModel>(storeName: string, ids: string[]): Promise<T[]>;
    putBulk(storeName: string, items: DataItem[]): Promise<any[]>;
    deleteBulk(storeName: string, ids: string[]): Promise<void>;
    readFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>>;
    saveFiles(files: FileItem[]): Promise<Attachment[]>;
    deleteFiles(fileIds: string[]): Promise<{ deleted: string[], failed: string[] }>;
    clearStore(storeName: string): Promise<boolean>;
}



// 本地协调器,使用协调数据类型，负责管理本地数据和同步
export interface ICoordinator {
    initSync?: () => Promise<void>;     // 可选：在manager中初始化会执行的函数
    disposeSync?: () => Promise<void>;  // 可选：卸载时执行的函数，清理资源
    getCurrentView(): Promise<SyncView>;
    readBulk(storeName: string, ids: string[]): Promise<DeltaModel[]>;
    putBulk(storeName: string, items: DeltaModel[]): Promise<DeltaModel[]>;
    uploadFiles(files: FileItem[]): Promise<Attachment[]>;
    deleteFiles(fileIds: string[]): Promise<void>;
    onDataChanged(callback: () => void): void; // 改为注册回调函数
    deleteBulk(storeName: string, ids: string[]): Promise<void>;
    downloadFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>>;
    applyChanges(changes: DataChange[]): Promise<void>;
    querySync(
        storeName: string,
        options?: SyncQueryOptions
    ): Promise<SyncQueryResult<DeltaModel>>;
}




export interface ISyncEngine {
    // 初始化
    initialize(): Promise<void>;
    // 自动同步控制
    enableAutoSync(interval?: number): void;
    disableAutoSync(): void;
    updateSyncOptions(options: Partial<SyncOptions>): void;
    // 云端适配器设置
    setCloudAdapter(cloudAdapter: DatabaseAdapter): Promise<void>;
    // 数据操作
    save<T extends Record<string, any>>(
        storeName: string,              // 存储名称
        data: T | T[],                 // 要保存的数据，支持单个对象或数组
        id?: string | string[]         // 可选的 ID，单个或数组，与 data 对应
    ): Promise<T[]>;    // 返回添加了 DeltaModel 属性的数据数组
    readFile(fileId: string): Promise<Blob | ArrayBuffer | null>;
    saveFile(fileId: string,
        file: File | Blob | ArrayBuffer,
        filename: string,
        mimeType: string,
        metadata?: Record<string, any>): Promise<Attachment>;
    delete(storeName: string, ids: string | string[]): Promise<void>;
    sync(): Promise<SyncResult>;
    push(): Promise<SyncResult>;
    pull(): Promise<SyncResult>;
    query<T extends Record<string, any>>(
        storeName: string,
        options?: SyncQueryOptions
    ): Promise<SyncQueryResult<T>>;
    getlocalCoordinator(): Promise<ICoordinator>;
    getlocalAdapter(): Promise<DatabaseAdapter>;
    // 清理和断开连接
    dispose(): void;
    disconnectCloud(): void;
}
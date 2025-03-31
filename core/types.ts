// types.ts
// 基础模型，附带用于同步的元信息


// 操作优先级
export type SyncOperationType = 'put' | 'delete';
export const OPERATION_PRIORITY: Record<SyncOperationType, number> = {
    'delete': 2,
    'put': 1,
} as const;


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


export interface BaseModel {
    _delta_id: string;  // 数据实体的唯一标识符（主键）
    _store?: string// 所属表名，这个数值不应该被修改
    _version?: number;// 版本号
    _attachments?: Attachment[]; // 文件附件列表
}


// 元数据
export interface MetaItem extends Omit<BaseModel, '_store'> {
    _store?: string;
    value: any;
}


export interface QueryOptions {
    since?: number;
    offset?: number;
    limit?: number;
    order?: 'asc' | 'desc';
}

export const DEFAULT_QUERY_OPTIONS: QueryOptions = {
    since: 0,
    offset: 0,
    limit: 100,
    order: 'asc',
};


// 数据库适配器,支持任意类型的数据库
export interface DatabaseAdapter {
    initSync(): Promise<void>;
    isAvailable(): Promise<boolean>;
    readByVersion<T extends BaseModel>(storeName: string, options?: QueryOptions): Promise<{ items: T[]; hasMore: boolean }>;
    readBulk<T extends BaseModel>(storeName: string, ids: string[]): Promise<T[]>;
    putBulk<T extends BaseModel>(storeName: string, items: T[]): Promise<T[]>;
    deleteBulk(storeName: string, ids: string[]): Promise<void>;
    // 读写文件相关的操作
    readFiles(fileIds: string[]): Promise<Map<string, Blob | ArrayBuffer | null>>;
    saveFiles(files: FileItem[]): Promise<Attachment[]>;
    deleteFiles(fileIds: string[]): Promise<{
        deleted: string[],
        failed: string[]
    }>;
    // 清空store
    clearStore(storeName: string): Promise<boolean>;
}



// 包含完整数据的变更记录
export interface DataChange<T = any> {
    _delta_id: string;      // 数据实体本身的唯一标识符,由store+原始数据的_delta_id计算
    _store: string;
    _version: number;
    _synced?: boolean; // 是否已同步过,只在本地使用
    type: SyncOperationType;
    data?: T;   // 发生变更后的完整数据
}


// 附件变更记录
export interface AttachmentChange {
    _delta_id: string;       // 变更记录ID
    _version: number;
    _synced?: boolean;      // 是否已同步过
    type: SyncOperationType;     // 操作类型,是put还是删除
}



// 返回的同步请求模型
export interface SyncResponse {
    success: boolean;
    error?: string;
    processed?: number;
    changes?: DataChange[];
    info?: {
        attachments_processed?: number;
        attachments_failed?: number;
    };
    version?: number;
}


// 获取用于存储到change表中的名称
export function getChangeId(storeName: string, deltaId: string): string {
    return `${storeName}_${deltaId}`;
}


// 获取change表中的数据对应的原始id
export function getOriginalId(combinedId: string, storeName: string): string {
    const prefix = `${storeName}_`;
    return combinedId.startsWith(prefix)
        ? combinedId.substring(prefix.length)
        : combinedId;
}




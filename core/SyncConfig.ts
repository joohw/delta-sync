// core/syncConfig.ts


export interface EncryptionConfig {
    enabled: boolean;
    keyProvider: () => Promise<CryptoKey | string>; // 提供加密密钥
    encryptFn: (data: any, key: CryptoKey | string) => Promise<any>; // 加密函数
    decryptFn: (data: any, key: CryptoKey | string) => Promise<any>; // 解密函数
    encryptedFields?: string[]; // 可选：指定需要加密的字段，默认全部
    nonEncryptedFields?: string[]; // 可选：指定不需要加密的字段
    encryptAttachments?: boolean; // 是否加密附件
}


// 同步器的设置
export interface SyncConfig {
    encryption?: EncryptionConfig;    // 端到端的加密配置
    maxRetries?: number;    // 最大重试次数
    timeout?: number;       // 超时时间(毫秒)
    maxFileSize?: number;   // 最大支持的文件大小(字节)
    batchSize?: number;     // 同步批次的数量
    payloadSize?: number;   // 传输的对象最大大小(字节)
    fileChunkSize?: number; // 文件分块存储的单块大小(字节)
}


// 默认配置
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
    maxRetries: 3,
    timeout: 30000,
    maxFileSize: 20 * 1024 * 1024, // 20MB
    fileChunkSize: 4 * 1024 * 1024, // 4MB
    batchSize: 100,
    payloadSize: 4 * 1024 * 1024,  // 4MB
};


export function getSyncConfig(userConfig?: Partial<SyncConfig>): SyncConfig {
    return {
        ...DEFAULT_SYNC_CONFIG,
        ...userConfig
    };
}
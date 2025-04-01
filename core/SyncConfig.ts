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



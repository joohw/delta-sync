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

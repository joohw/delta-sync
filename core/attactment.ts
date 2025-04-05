export interface Attachment {
    id: string;               // unique id of attachment
    filename: string;         // filename
    mimeType: string;         // MIME type
    size: number;             // file size in bytes
    createdAt: number;        // creation timestamp
    updatedAt: number;        // last update timestamp
    metadata: Record<string, any>;  // metadata
    missingAt?: number;       // timestamp when marked as missing
}

export interface FileItem {
    fileId: string,           // unique storage key corresponding to Attachment.id
    content: Blob | ArrayBuffer | string,  // file binary data
}

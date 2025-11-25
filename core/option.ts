// merge sync options with default options
import {
    DataChangeSet,
    SyncProgress,
    SyncStatus,
} from './types';


// 同步的设置选项
export interface SyncOptions {
    autoSync?: {
        enabled?: boolean;
        pullInterval?: number;
        pushDebounce?: number;
        retryDelay?: number;
    };
    onStatusUpdate?: (status: SyncStatus) => void;
    onSyncProgress?: (progress: SyncProgress) => void;
    onVersionUpdate?: (_ver: number) => void;
    onChangePushed?: (changes: DataChangeSet) => void;
    onChangePulled?: (changes: DataChangeSet) => void;
    onPullAvailableCheck?: () => boolean;   // pull availability check function
    onPushAvailableCheck?: () => boolean;   // push availability check function
    maxRetries?: number;    // maximum retry count
    timeout?: number;       // timeout in milliseconds
    batchSize?: number;     // sync batch size
    payloadSize?: number;   // maximum object size in bytes
    maxFileSize?: number;   // maximum supported file size in bytes
    fileChunkSize?: number; // single chunk size for file storage in bytes
}


// 补全默认的同步设置
export const createDefaultOptions = (options: SyncOptions): SyncOptions => {
    return {
        autoSync: {
            enabled: false,
            pullInterval: 600000,
            pushDebounce: 10000,
            retryDelay: 3000,
            ...options.autoSync
        },
        maxRetries: 3,
        timeout: 30000,
        batchSize: 100,
        maxFileSize: 10 * 1024 * 1024,
        fileChunkSize: 1024 * 1024,
        ...options
    };
}
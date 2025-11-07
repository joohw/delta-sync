// core/types.ts

import { SyncViewItem } from './SyncView';
export const TOMBSTONE_STORE = 'tombStones';
export const TOMBSTONE_RETENTION = 180 * 24 * 60 * 60 * 1000;


// 同步状态
export enum SyncStatus {
    REJECTED = -3,        // Error status
    ERROR = -2,        // Error status
    OFFLINE = -1,      // Offline status
    IDLE = 0,         // Idle status
    UPLOADING = 1,    // Upload synchronization in progress
    DOWNLOADING = 2,  // Download synchronization in progress
    OPERATING = 3,    // Operation in progress (clearing notes and other special operations)
    CHECKING = 4,     // Checking for changes in cloud
}


// 同步进度
export interface SyncProgress {
    processed: number;
    total: number;
}


// 包含单条数据的完整数据变更
export interface DataChange<T = any> {
    id: string;
    _ver: number;
    data?: T;
}


// 数据变更集合
export interface DataChangeSet {
    put: Map<string, DataChange[]>;
    delete: Map<string, DataChange[]>;
}



export interface DatabaseAdapter {
    readStore<T extends { id: string }>(
        storeName: string,
        limit?: number,
        offset?: number
    ): Promise<{ items: T[]; hasMore: boolean }>;
    listStoreItems(
        storeName: string,
        offset?: number,
        since?: number,
        before?: number,
    ): Promise<{
        items: SyncViewItem[];
        hasMore?: boolean,
        offset?: number
    }>;
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
}



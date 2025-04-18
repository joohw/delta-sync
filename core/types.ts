// core/types.ts

export type SyncOperationType = 'put' | 'delete';


export interface SyncQueryOptions {
    since?: number;      // Query data after specified _ver
    limit?: number;      // Limit number of returned items
    offset?: number;     // Starting position
    includeDeleted?: boolean;
}


export interface SyncQueryResult<T = any> {
    items: T[];
    hasMore: boolean;
}



export interface SyncProgress {
    processed: number;
    total: number;
}


// model for synchronization result
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
        pullInterval?: number;
        pushDebounce?: number;
        retryDelay?: number;
    };
    onStatusUpdate?: (status: SyncStatus) => void;
    onVersionUpdate?: (_ver: number) => void;
    onChangePushed?: (changes: DataChangeSet) => void;
    onChangePulled?: (changes: DataChangeSet) => void;
    onSyncProgress?: (progress: SyncProgress) => void;
    onPullAvailableCheck?: () => boolean;   // pull availability check function
    onPushAvailableCheck?: () => boolean;   // push availability check function
    maxRetries?: number;    // maximum retry count
    timeout?: number;       // timeout in milliseconds
    batchSize?: number;     // sync batch size
    payloadSize?: number;   // maximum object size in bytes
    maxFileSize?: number;   // maximum supported file size in bytes
    fileChunkSize?: number; // single chunk size for file storage in bytes
}


export interface SyncViewItem {
    id: string;
    store: string;
    _ver: number;
    deleted?: boolean;      // markd as deleted
    isAttachment?: boolean; // markd as attachment
}

export interface DeletedItem extends Record<string, any> {
    id: string;
    _ver: number;
    deleted: boolean;
}



export interface DataChange<T = any> {
    id: string;
    _ver: number;
    data?: T;   //data for put operation
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
    // Add or update record
    upsert(item: SyncViewItem): void {
        const key = this.getKey(item.store, item.id);
        this.items.set(key, item);
        if (!this.storeIndex.has(item.store)) {
            this.storeIndex.set(item.store, new Set());
        }
        this.storeIndex.get(item.store)!.add(item.id);
    }
    // Batch update records
    upsertBatch(items: SyncViewItem[]): void {
        for (const item of items) {
            this.upsert(item);
        }
    }
    // Get specific record
    get(store: string, id: string): SyncViewItem | undefined {
        return this.items.get(this.getKey(store, id));
    }
    // Get paginated records for specified store
    getByStore(store: string, offset: number = 0, limit: number = 100): SyncViewItem[] {
        const storeItems = this.storeIndex.get(store);
        if (!storeItems) return [];
        return Array.from(storeItems)
            .slice(offset, offset + limit)
            .map(id => this.items.get(this.getKey(store, id))!)
            .filter(item => item !== undefined);
    }
    // Get all store names
    getStores(): string[] {
        return Array.from(this.storeIndex.keys())
    }
    // Compare differences between two views
    static diffViews(local: SyncView, remote: SyncView): {
        toDownload: SyncViewItem[];
        toUpload: SyncViewItem[];
    } {
        const toDownload: SyncViewItem[] = [];
        const toUpload: SyncViewItem[] = [];
        const allKeys = new Set([...local.items.keys(), ...remote.items.keys()]);
    
        for (const key of allKeys) {
            const localItem = local.items.get(key);
            const remoteItem = remote.items.get(key);

            if (!localItem && remoteItem) {
                // 本地没有，远程有
                toDownload.push(remoteItem);
            } else if (localItem && !remoteItem) {
                // 本地有，远程没有
                toUpload.push(localItem);
            } else if (localItem && remoteItem) {
                // 两边都有，需要比较版本和删除状态
                if (localItem._ver !== remoteItem._ver || localItem.deleted !== remoteItem.deleted) {
                    if (localItem._ver > remoteItem._ver) {
                        toUpload.push(localItem);
                    } else if (localItem._ver < remoteItem._ver) {
                        toDownload.push(remoteItem);
                    } else {
                        // 版本相同但删除状态不同时，以远程为准
                        toDownload.push(remoteItem);
                    }
                }
            }
        }
        return { toDownload, toUpload };
    }
    // Generate composite key
    private getKey(store: string, id: string): string {
        return `${store}:${id}`;
    }
    // Delete record
    delete(store: string, id: string): void {
        const key = this.getKey(store, id);
        this.items.delete(key);
        this.storeIndex.get(store)?.delete(id);
    }
    // Get total storage size
    size(): number {
        return this.items.size;
    }
    // Get record count for specific store
    storeSize(store: string): number {
        return this.storeIndex.get(store)?.size || 0;
    }
    // Clear all data
    clear(): void {
        this.items.clear();
        this.storeIndex.clear();
    }
    countByStore(store: string, includeDeleted: boolean = false): number {
        const storeItems = this.storeIndex.get(store);
        if (!storeItems) {
            return 0;
        }
        if (includeDeleted) {
            return storeItems.size;
        } else {
            let activeCount = 0;
            for (const id of storeItems) {
                const item = this.get(store, id);
                if (item && !item.deleted) {
                    activeCount++;
                }
            }
            return activeCount;
        }
    }
}



//  any database adapter to the SyncEngine
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




// Local coordinator interface definition
export interface ICoordinator {
    // Lifecycle methods
    initSync?: () => Promise<void>;     // Optional: execute during initialization
    disposeSync?: () => Promise<void>;  // Optional: execute during disposal
    // Core data operation methods
    query<T extends { id: string }>(
        storeName: string,
        options?: SyncQueryOptions
    ): Promise<SyncQueryResult<T>>;
    // Sync view related
    getCurrentView(): Promise<SyncView>;
    // Bulk data operations
    readBulk<T extends { id: string }>(
        storeName: string,
        ids: string[]
    ): Promise<T[]>;
    putBulk<T extends { id: string }>(
        storeName: string,
        items: T[],
    ): Promise<T[]>;
    deleteBulk(
        storeName: string,
        ids: string[]
    ): Promise<void>;
    extractChanges(items: SyncViewItem[]): Promise<DataChangeSet>;
    applyChanges(changeSet: DataChangeSet): Promise<void>;
}




export interface ISyncEngine {
    // Initialize sync engine
    initialize(): Promise<void>;
    // Auto sync control
    enableAutoSync(interval?: number): void;
    disableAutoSync(): void;
    updateSyncOptions(options: Partial<SyncOptions>): SyncOptions;
    // Cloud adapter configuration
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
    clearLocalStores(strings: string | string[]): Promise<void>;
    getlocalAdapter(): DatabaseAdapter;
    getlocalCoordinator(): ICoordinator;
    getCloudAdapter(): DatabaseAdapter|undefined;
    getCloudCoordinator(): ICoordinator|undefined;
    dispose(): void;
    disconnectCloud(): void;
}
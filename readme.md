# DeltaSync

[![npm version](https://img.shields.io/npm/v/delta-sync.svg)](https://www.npmjs.com/package/delta-sync)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

**A Lightweight Cross-platform Data Synchronization Engine**

DeltaSync is a data synchronization framework designed for modern applications, helping developers easily implement bi-directional synchronization, offline storage, and conflict resolution. Whether it's web applications, mobile apps, or desktop applications, DeltaSync provides consistent synchronization experience.

## Core Features

- **Lightweight & Flexible**: Core code less than 2000 lines, few dependencies
- **Adapter Pattern**: Easily integrate with any database system
- **Version Control**: Automatically track data changes with timestamp-based versions
- **Incremental Sync**: Only synchronize changed data for better performance using checkpoint mechanism
- **Offline Support**: Complete offline working capability with automatic sync when network recovers
- **Type Safety**: Written in TypeScript with complete type definitions
- **Batch Processing**: Support batch data synchronization
- **Complete Events**: Rich synchronization event callbacks
- **Tombstone Mechanism**: Proper deletion tracking with retention policy

## Installation

```bash
npm install delta-sync
```

## Quick Start

1. Create Database Adapter:

```typescript
import { DatabaseAdapter } from 'delta-sync';

class MyDatabaseAdapter implements DatabaseAdapter {
  async readStore<T extends { id: string }>(
    storeName: string,
    limit?: number,
    offset?: number
  ): Promise<{ items: T[]; hasMore: boolean }> {
    // Implement data reading logic
  }

  async listStoreItems(
    storeName: string,
    offset?: number,
    since?: number,
    before?: number
  ): Promise<{
    items: Array<{ id: string; _ver: number; store?: string; deleted?: boolean }>;
    hasMore?: boolean;
    offset?: number;
  }> {
    // Implement list items logic (for sync view)
  }

  async readBulk<T extends { id: string }>(
    storeName: string,
    ids: string[]
  ): Promise<T[]> {
    // Implement bulk read logic
  }

  async putBulk<T extends { id: string }>(
    storeName: string,
    items: T[]
  ): Promise<T[]> {
    // Implement bulk write logic
  }

  async deleteBulk(storeName: string, ids: string[]): Promise<void> {
    // Implement bulk delete logic
  }

  async clearStore(storeName: string): Promise<boolean> {
    // Implement clear store logic
  }
}
```

2. Initialize Sync Engine:

```typescript
import { SyncEngine } from 'delta-sync';

const localAdapter = new MyDatabaseAdapter();
const cloudAdapter = new MyCloudAdapter();

// Specify which stores to sync
const storesToSync = ['notes', 'tasks', 'tombStones'];

const engine = new SyncEngine(localAdapter, storesToSync, {
  autoSync: {
    enabled: true,
    pullInterval: 60000, // Auto sync every 60 seconds
    pushDebounce: 10000 // Push local changes after 10 seconds
  },
  onStatusUpdate: (status) => {
    console.log('Sync Status:', status);
  }
});

// Initialize the engine
await engine.initialize();

// Set cloud adapter
await engine.setCloudAdapter(cloudAdapter);
```

3. Data Operations:

```typescript
// Save data (single or batch)
await engine.save('notes', {
  id: '1',
  title: 'Test Note',
  content: 'Content...'
});

// Save multiple items
await engine.save('notes', [
  { id: '1', title: 'Note 1', content: '...' },
  { id: '2', title: 'Note 2', content: '...' }
]);

// Delete data
await engine.delete('notes', '1');
// Or delete multiple
await engine.delete('notes', ['1', '2']);
```

## Synchronization Principles

DeltaSync uses a version-based incremental synchronization mechanism:

1. **Version Tracking**: Each data item has a `_ver` field (timestamp-based version number)

2. **Change Tracking**: Uses `SyncView` to store the latest version information of all data for fast comparison

3. **Sync Modes**:
   - **Sync (`sync`)**: Loads local + cloud metadata **once each**, computes upload and pull diffs in one step (`getRoundTripDiff`), then **applies push then pull**; updates checkpoint once at end of the round
   - **Incremental**: `sync()` uses internal `checkpoint` as `since` for `listStoreItems` (`_ver > since`)
   - **Full listing**: Call `sync(stores, 0)` when your adapter treats `since === 0` as listing all changes (see adapter docs)
   - **Conflict Resolution**: Adopts "latest version wins" strategy (higher `_ver` wins)

4. **Tombstone Mechanism**: 
   - Deleted items are tracked in a special `tombStones` store
   - Tombstones are retained for 180 days by default
   - Ensures proper deletion propagation across all devices

5. **Offline Support**: 
   - Works normally offline
   - Changes are cached and synced automatically when network recovers
   - Prevents duplicate synchronization

## Advanced Features

### Sync Methods

```typescript
// Sync: one metadata pass per side + one combined diff (getRoundTripDiff), then push then pull
await engine.sync();

// Optional explicit store list / since (e.g. full listing when adapter uses `since === 0`)
// await engine.sync(['notes', 'decks'], 0);
```

### Custom Sync Options

```typescript
engine.updateSyncOptions({
  maxRetries: 3, // Maximum retry attempts
  timeout: 30000, // Timeout (ms)
  batchSize: 100, // Batch sync size
  maxFileSize: 10485760, // Maximum file size (10MB)
  fileChunkSize: 1048576, // File chunk size (1MB)
  autoSync: {
    enabled: true,
    pullInterval: 60000, // Pull interval in ms
    pushDebounce: 10000, // Push debounce delay in ms
    retryDelay: 3000 // Retry delay in ms
  }
});
```

### Sync Event Listeners

```typescript
const options = {
  onStatusUpdate: (status: SyncStatus) => {
    console.log('Sync Status:', status);
  },
  onSyncProgress: (progress: { processed: number; total: number }) => {
    console.log(`Progress: ${progress.processed}/${progress.total}`);
  },
  onVersionUpdate: (version: number) => {
    console.log('Latest version updated to:', version);
  },
  onChangePushed: (changes: DataChangeSet) => {
    console.log('Pushed Changes:', changes);
  },
  onChangePulled: (changes: DataChangeSet) => {
    console.log('Pulled Changes:', changes);
  },
  onPullAvailableCheck: () => {
    // Return true if pull is allowed
    return navigator.onLine;
  },
  onPushAvailableCheck: () => {
    // Return true if push is allowed
    return navigator.onLine;
  }
};
```

### Store Management

```typescript
// Clear local stores
await engine.clearLocalStores('notes');
await engine.clearLocalStores(['notes', 'tasks']);

// Clear cloud stores
await engine.clearCloudStores('notes');
await engine.clearCloudStores(['notes', 'tasks']);
```

### Auto Sync Control

```typescript
// Enable auto sync
engine.enableAutoSync(60000); // 60 seconds interval

// Disable auto sync
engine.dispose(); // Also clears timers and resets state
```

## Adapter Development

To develop custom adapters, implement the `DatabaseAdapter` interface:

```typescript
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
    before?: number
  ): Promise<{
    items: SyncViewItem[];
    hasMore?: boolean;
    offset?: number;
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
```

**Important Notes:**
- `listStoreItems` should return items sorted by `_ver` in descending order for efficient checkpoint-based incremental sync
- The `since` parameter in `listStoreItems` is used for incremental sync (only return items with `_ver > since`)
- The `before` parameter can be used for filtering old tombstones
- Items must include `id` and `_ver` fields

## Technical Architecture

### Core Components

1. **SyncEngine**: Main synchronization controller
   - Manages sync lifecycle
   - Coordinates local and cloud operations
   - Handles automatic sync scheduling
   - Provides data operation methods (save, delete)

2. **SyncView**: Data view for fast comparison
   - Stores lightweight metadata (id, version, store, deleted flag)
   - Enables efficient diff calculation
   - Supports incremental sync via checkpoints

3. **DatabaseAdapter**: Database interface
   - Provides unified data access
   - Abstracts database operations
   - Ensures cross-platform compatibility

4. **Checkpoint Mechanism**: 
   - Tracks latest version per store
   - Enables efficient incremental sync
   - Reduces data transfer for large datasets

### Sync Status

```typescript
export enum SyncStatus {
  REJECTED = -3,  // Push rejected by availability check
  ERROR = -2,     // Error status
  OFFLINE = -1,   // Offline status
  IDLE = 0,       // Idle status
  UPLOADING = 1,  // Upload in progress
  DOWNLOADING = 2, // Download in progress
  OPERATING = 3,  // Operation in progress (clearing stores, etc.)
  CHECKING = 4,   // Checking for changes in cloud
}
```

### Version Control

- Each data item has a `_ver` (version) field
- Version numbers are timestamp-based (milliseconds since epoch)
- Supports conflict detection and resolution (latest version wins)
- Versions are automatically assigned on save operations

### Data Structure

All data items must have:
- `id: string` - Unique identifier
- `_ver: number` - Version number (timestamp)

Example:
```typescript
interface Note {
  id: string;
  _ver: number; // Automatically set by SyncEngine
  title: string;
  content: string;
  // ... other fields
}
```

## Performance Considerations

- **Batch Processing**: All operations use batch processing for better efficiency
- **Incremental Sync**: Checkpoint mechanism reduces data transfer significantly
- **Debounce Mechanism**: Local changes are debounced before pushing to reduce network calls
- **Memory-efficient**: SyncView uses lightweight metadata instead of full data
- **Lazy Loading**: Data is loaded on-demand during sync operations

## Best Practices

1. **Store Naming**: Always include `'tombStones'` in your `storesToSync` array if you need deletion tracking
2. **Initialization**: Always call `engine.initialize()` before using the engine
3. **Error Handling**: Implement proper error handling in your adapters
4. **Version Management**: Never manually modify `_ver` field - let SyncEngine handle it
5. **Cleanup**: Call `engine.dispose()` when done to clean up timers and resources

## License

ISC

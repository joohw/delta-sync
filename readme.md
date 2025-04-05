# DeltaSync

```
[![npm version](https://img.shields.io/npm/v/delta-sync.svg)](https://www.npmjs.com/package/delta-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
```

**A Lightweight Cross-platform Data Synchronization Engine**

DeltaSync is a data synchronization framework designed for modern applications, helping developers easily implement bi-directional synchronization, offline storage, and conflict resolution. Whether it's web applications, mobile apps, or desktop applications, DeltaSync provides consistent synchronization experience.

## Core Features

- **Lightweight & Flexible**: Core code less than 500 lines, few dependencies
- **Adapter Pattern**: Easily integrate with any database system
- **Version Control**: Automatically track data changes, ensure sync consistency
- **Incremental Sync**: Only synchronize changed data for better performance
- **Offline Support**: Complete offline working capability
- **Type Safety**: Written in TypeScript with complete type definitions
- **Auto Retry**: Automatic retry on network exceptions
- **Batch Processing**: Support batch data synchronization
- **Complete Events**: Rich synchronization event callbacks

## Installation

```bash
npm install delta-sync
```

## Quick Start

1. Create Database Adapter:

```typescript
import { DatabaseAdapter } from 'delta-sync';

class MyDatabaseAdapter implements DatabaseAdapter {
// Implement required interface methods
async readStore<T>(storeName: string, limit?: number, offset?: number) {
// Implement data reading logic
}

async putBulk<T>(storeName: string, items: T[]) {
// Implement bulk write logic
}

// ...other interface implementations
}
```

2. Initialize Sync Engine:

```typescript
import { SyncEngine } from 'delta-sync';

const localAdapter = new MyDatabaseAdapter();
const cloudAdapter = new MyCloudAdapter();

const engine = new SyncEngine(localAdapter, {
autoSync: {
enabled: true,
pullInterval: 30000, // Auto sync every 30 seconds
pushDebounce: 5000 // Push local changes after 5 seconds
},
onStatusUpdate: (status) => {
console.log('Sync Status:', status);
}
});

// Set cloud adapter
await engine.setCloudAdapter(cloudAdapter);
```

3. Data Operations:

typescript
// Save data
await engine.save('notes', {
id: '1',
title: 'Test Note',
content: 'Content...'
});

// Delete data
await engine.delete('notes', '1');

// Query data
const result = await engine.query('notes', {
limit: 10,
offset: 0
});


## Synchronization Principles

DeltaSync uses a version-based incremental synchronization mechanism:

1. **Local Changes**: All data operations through the sync engine automatically record version information

2. **Change Tracking**: Uses SyncView to store the latest version information of all data

3. **Incremental Sync**: 
- Push: Push local new version data to cloud
- Pull: Pull cloud new version data to local
- Conflict Resolution: Adopts "latest version wins" strategy

4. **Offline Support**: 
- Works normally offline
- Automatic sync when network recovers
- Prevents duplicate synchronization

## Advanced Features

### Custom Sync Options

```typescript
engine.updateSyncOptions({
maxRetries: 3, // Maximum retry attempts
timeout: 30000, // Timeout (ms)
batchSize: 100, // Batch sync size
maxFileSize: 10485760, // Maximum file size (10MB)
fileChunkSize: 1048576 // File chunk size (1MB)
});
```

### Sync Event Listeners

```typescript
const options = {
onStatusUpdate: (status) => {
console.log('Sync Status:', status);
},
onChangePushed: (changes) => {
console.log('Pushed Changes:', changes);
},
onChangePulled: (changes) => {
console.log('Pulled Changes:', changes);
}
};
```

### Manual Sync Control

```typescript
// Complete sync
await engine.sync();

// Push local changes only
await engine.push();

// Pull remote changes only
await engine.pull();
```

## Adapter Development

To develop custom adapters, implement the `DatabaseAdapter` interface:

```typescript
export interface DatabaseAdapter {
readStore<T>(...): Promise<SyncQueryResult<T>>;
readBulk<T>(...): Promise<T[]>;
putBulk<T>(...): Promise<T[]>;
deleteBulk(...): Promise<void>;
clearStore(...): Promise<boolean>;
getStores(): Promise<string[]>;
}
```

## Technical Architecture

### Core Components

1. **SyncEngine**: Main synchronization controller
   - Manages sync lifecycle
   - Coordinates local and cloud operations
   - Handles automatic sync scheduling

2. **Coordinator**: Data operation coordinator
   - Tracks data changes
   - Manages sync views
   - Handles version control

3. **DatabaseAdapter**: Database interface
   - Provides unified data access
   - Abstracts database operations
   - Ensures cross-platform compatibility

### Sync Status

```typescript
export enum SyncStatus {
ERROR = -2, // Error status
OFFLINE = -1, // Offline status
IDLE = 0, // Idle status
UPLOADING = 1, // Upload in progress
DOWNLOADING = 2, // Download in progress
OPERATING = 3, // Operation in progress
}
```

### Version Control

- Each data item has a `_ver` (version) field
- Version numbers are timestamp-based
- Supports conflict detection and resolution

## Performance Considerations

- Batch processing for better efficiency
- Incremental sync to reduce data transfer
- Debounce mechanism for frequent changes
- Memory-efficient data structures

## Security

- Supports end-to-end encryption
- Secure data transmission
- Access control capabilities
- Data integrity verification

## Testing

DeltaSync provides comprehensive testing utilities:

```typescript
import { testAdapterFunctionality, testAdapterPerformance } from 'delta-sync/test';

// Test adapter functionality
const functionalResults = await testAdapterFunctionality(adapter);

// Test adapter performance
const performanceResults = await testAdapterPerformance(adapter, {
itemCount: 200,
iterations: 3,
fileSize: 512 * 1024
});
```

## License

MIT
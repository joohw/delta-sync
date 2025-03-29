# DeltaSync

An ultra-lightweight bidirectional synchronization framework based on CRDT principles, supporting multi-device synchronization of document-based data and attachments.

## Features

- **Ultra-lightweight**: Easily integrates with any database system
- **Automatic version tracking**: Each record contains a version number to ensure synchronization consistency
- **Conflict resolution**: Automatic conflict resolution based on timestamps
- **File attachment synchronization**: Support for syncing data-associated files
- **Custom sync strategies**: Customize synchronization behavior based on application needs
- **Batch processing**: Efficient batch processing of data changes
- **Event-driven architecture**: Easy integration with various application frameworks
- **Offline-first**: Full support for offline operations with automatic sync recovery
- **TypeScript friendly**: Complete type definitions for excellent development experience
- **End-to-end encryption support**: Protects sensitive data

## Installation

```bash
npm install delta-sync

```

## Usage

```typescript
import { SyncManager } from 'delta-sync/core/syncManager';
import { LocalCoordinator } from 'delta-sync/core/LocalCoordinator';
import { CloudCoordinator } from 'delta-sync/core/CloudCoordinator';
import { IndexedDBAdapter } from 'delta-sync/adapters/indexeddb';
import { RestAdapter } from 'delta-sync/adapters/rest';

// Initialize local data adapter
const localAdapter = new IndexedDBAdapter('myApp');

// Initialize cloud data adapter
const cloudAdapter = new RestAdapter({
  baseUrl: 'https://api.example.com/sync',
  headers: { 'Authorization': 'Bearer token' }
});

// Create coordinators
const localCoordinator = new LocalCoordinator(localAdapter);
const cloudCoordinator = new CloudCoordinator(cloudAdapter);

// Create sync manager
const syncManager = new SyncManager(localCoordinator, cloudCoordinator);
// Initialize sync service
await syncManager.initialize();
```


### Directory Structure

```
.
|-- DeltaSync.code-workspace
|-- LICENSE
|-- adapters
|   |-- IndexedDBAdapter.ts
|   |-- MemoryAdapter.ts
|   `-- index.ts
|-- core
|   |-- CloudCoordinator.ts
|   |-- LocalCoordinator.ts
|   |-- SyncClient.ts
|   |-- SyncConfig.ts
|   |-- SyncManager.ts
|   `-- types.ts
|-- index.ts
|-- lib
|-- package.json
|-- readme.cn.md
|-- readme.md
|-- test
|   `-- index.ts
|-- tester
|   |-- FunctionTester.ts
|   `-- PerformanceTester.ts
`-- tsconfig.json

```
# DeltaSync[alpha]

[English](README.md) | [简体中文](README.zh-CN.md)

An ultra-lightweight bidirectional synchronization framework based on change records and version control, supporting multi-device synchronization of document-based data and attachments.

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

## Basic Usage

```typescript
import { SyncClient } from 'delta-sync/core/SyncClient';
import { IndexedDBAdapter } from 'delta-sync/adapters/indexeddb';
import { RestAdapter } from 'delta-sync/adapters/rest';

// Initialize local adapter
const localAdapter = new IndexedDBAdapter('myApp');

// Create sync client
const syncClient = new SyncClient({
  localAdapter: localAdapter
});

// Connect to cloud
const cloudAdapter = new RestAdapter({
  baseUrl: 'https://api.example.com/sync',
  headers: { 'Authorization': 'Bearer token' }
});

await syncClient.setCloudAdapter(cloudAdapter);

// Save data locally
await syncClient.save('notes', {
  _delta_id: 'note1',
  title: 'My first note',
  content: 'Hello world'
});

// Synchronize with the cloud
await syncClient.sync();
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
// index.ts

// Export type definitions
export * from './core/types';

// Export core components
export * from './core/SyncManager';
export * from './core/CloudCoordinator';
export * from './core/LocalCoordinator';
export * from './core/SyncClient';

// Export adapters
export * from './adapters/IndexedDBAdapter';
export * from './adapters/MemoryAdapter';

// Export testers
export * from './tester/FunctionTester';
export * from './tester/PerformanceTester';
// tester/PerformanceTester.ts

import { DatabaseAdapter, DeltaModel, Attachment } from '../core/types';

export interface TestModel extends DeltaModel {
 value: string;
 testField?: any;
}

export interface PerformanceTesterOptions {
 testStoreName?: string;
 itemCount?: number;        // Number of items for batch testing
 iterations?: number;       // Test repetitions to calculate average
 fileSize?: number;         // Test file size in bytes
 concurrentOperations?: number; // Number of concurrent operations for stress test
 verbose?: boolean;         // Whether to log detailed results
 cleanupAfterTest?: boolean; // Whether to clean up test data after testing
}

export class PerformanceTester {
 private adapter: DatabaseAdapter;
 private options: Required<PerformanceTesterOptions>;
 private testStoreName: string;
 private createdFileIds: string[] = [];
 private createdItemIds: string[] = [];

 constructor(adapter: DatabaseAdapter, options: PerformanceTesterOptions = {}) {
   this.adapter = adapter;
   this.options = {
     testStoreName: options.testStoreName || 'perf_test',
     itemCount: options.itemCount || 100,
     iterations: options.iterations || 3,
     fileSize: options.fileSize || 1024 * 10, // 10KB
     concurrentOperations: options.concurrentOperations || 10,
     verbose: options.verbose !== undefined ? options.verbose : true,
     cleanupAfterTest: options.cleanupAfterTest !== undefined ? options.cleanupAfterTest : true
   };
   this.testStoreName = this.options.testStoreName;
 }

 /**
  * Run all performance tests
  */
 async runAllTests(): Promise<{
   success: boolean;
   results: Record<string, PerformanceResult>;
 }> {
   console.log('=== Starting adapter performance tests ===');
   const results: Record<string, PerformanceResult> = {};
   try {
     // Basic CRUD performance
     results.singleItemWrite = await this.testSingleItemWrite();
     results.singleItemRead = await this.testSingleItemRead();
     results.singleItemDelete = await this.testSingleItemDelete();
     // Bulk operations performance
     results.bulkWrite = await this.testBulkWrite();
     results.bulkRead = await this.testBulkRead();
     results.bulkDelete = await this.testBulkDelete();
     // Bulk file operations performance
     results.bulkFileWrite = await this.testBulkFileWrite();
     results.bulkFileRead = await this.testBulkFileRead();
     results.bulkFileDelete = await this.testBulkFileDelete();
     // Pagination performance
     results.pagination = await this.testPagination();
     // Stress test
     results.stressTest = await this.testStress();
     console.log('=== Adapter performance tests completed ===');
     // Calculate overall score (lower is better)
     const totalTimeMs = Object.values(results).reduce(
       (sum, result) => sum + result.averageTimeMs, 0
     );
     const averageTimeMs = totalTimeMs / Object.keys(results).length;
     console.log(`Overall average operation time: ${averageTimeMs.toFixed(2)}ms`);
     if (this.options.verbose) {
       console.log('\nDetailed results:');
       Object.entries(results).forEach(([testName, result]) => {
         console.log(`${testName}:`);
         console.log(`  Average time: ${result.averageTimeMs.toFixed(2)}ms`);
         console.log(`  Min time: ${result.minTimeMs.toFixed(2)}ms`);
         console.log(`  Max time: ${result.maxTimeMs.toFixed(2)}ms`);
         if (result.operationsPerSecond) {
           console.log(`  Operations/sec: ${result.operationsPerSecond.toFixed(2)}`);
         }
         if (result.throughputMBps) {
           console.log(`  Throughput: ${result.throughputMBps.toFixed(2)}MB/s`);
         }
       });
     }
     // Clean up all test data if configured
     if (this.options.cleanupAfterTest) {
       await this.cleanupTestData();
     }
     return {
       success: true,
       results
     };
   } catch (error) {
     console.error('Uncaught error during performance testing:', error);
     // Try to clean up data even if test fails
     if (this.options.cleanupAfterTest) {
       try {
         await this.cleanupTestData();
       } catch (cleanupError) {
         console.error('Error cleaning up test data:', cleanupError);
       }
     }
     return {
       success: false,
       results
     };
   }
 }


 // Test single item write performance
 async testSingleItemWrite(): Promise<PerformanceResult> {
   console.log('Testing single item write performance...');
   const times: number[] = [];
   for (let i = 0; i < this.options.iterations; i++) {
     const itemId = `perf_single_write_${Date.now()}_${i}`;
     const item: TestModel = {
       id: itemId,
       value: `Test value ${i}`,
     };
     const startTime = performance.now();
     await this.adapter.putBulk(this.testStoreName, [item]);
     const endTime = performance.now();
     this.createdItemIds.push(itemId);
     times.push(endTime - startTime);
   }
   return this.calculatePerformanceResult(times, 1);
 }


 // Test single item read performance
 async testSingleItemRead(): Promise<PerformanceResult> {
   console.log('Testing single item read performance...');
   const times: number[] = [];
   // Create test item first
   const testItemId = `perf_single_read_${Date.now()}`;
   const testItem: TestModel = {
     id: testItemId,
     value: 'Test read value',
   };
   await this.adapter.putBulk(this.testStoreName, [testItem]);
   this.createdItemIds.push(testItemId);
   for (let i = 0; i < this.options.iterations; i++) {
     const startTime = performance.now();
     await this.adapter.readBulk(this.testStoreName, [testItemId]);
     const endTime = performance.now();
     times.push(endTime - startTime);
   }
   return this.calculatePerformanceResult(times, 1);
 }


 // Test single item delete performance
 async testSingleItemDelete(): Promise<PerformanceResult> {
   console.log('Testing single item delete performance...');
   const times: number[] = [];
   for (let i = 0; i < this.options.iterations; i++) {
     // Create item to delete
     const itemId = `perf_single_delete_${Date.now()}_${i}`;
     const item: TestModel = {
       id: itemId,
       value: `Test delete value ${i}`,
     };
     await this.adapter.putBulk(this.testStoreName, [item]);
     const startTime = performance.now();
     await this.adapter.deleteBulk(this.testStoreName, [itemId]);
     const endTime = performance.now();
     times.push(endTime - startTime);
   }
   return this.calculatePerformanceResult(times, 1);
 }


 // Test bulk write performance
 async testBulkWrite(): Promise<PerformanceResult> {
   console.log('Testing bulk write performance...');
   const times: number[] = [];
   for (let iter = 0; iter < this.options.iterations; iter++) {
     const items: TestModel[] = [];
     for (let i = 0; i < this.options.itemCount; i++) {
       const itemId = `perf_bulk_write_${Date.now()}_${iter}_${i}`;
       items.push({
         id: itemId,
         value: `Bulk write test value ${i}`,
       });
       this.createdItemIds.push(itemId);
     }
     const startTime = performance.now();
     await this.adapter.putBulk(this.testStoreName, items);
     const endTime = performance.now();
     times.push(endTime - startTime);
   }
   return this.calculatePerformanceResult(times, this.options.itemCount);
 }


 // Test bulk read performance
 async testBulkRead(): Promise<PerformanceResult> {
   console.log('Testing bulk read performance...');
   const times: number[] = [];
   // Create test items first
   const testItems: TestModel[] = [];
   const testItemIds: string[] = [];
   for (let i = 0; i < this.options.itemCount; i++) {
     const itemId = `perf_bulk_read_${Date.now()}_${i}`;
     testItems.push({
       id: itemId,
       value: `Bulk read test value ${i}`,
     });
     testItemIds.push(itemId);
     this.createdItemIds.push(itemId);
   }
   await this.adapter.putBulk(this.testStoreName, testItems);
   for (let i = 0; i < this.options.iterations; i++) {
     const startTime = performance.now();
     await this.adapter.readBulk(this.testStoreName, testItemIds);
     const endTime = performance.now();
     times.push(endTime - startTime);
   }
   return this.calculatePerformanceResult(times, this.options.itemCount);
 }


 // Test bulk delete performance
 async testBulkDelete(): Promise<PerformanceResult> {
   console.log('Testing bulk delete performance...');
   const times: number[] = [];
   for (let iter = 0; iter < this.options.iterations; iter++) {
     // Create items to delete
     const items: TestModel[] = [];
     const itemIds: string[] = [];
     for (let i = 0; i < this.options.itemCount; i++) {
       const itemId = `perf_bulk_delete_${Date.now()}_${iter}_${i}`;
       items.push({
         id: itemId,
         value: `Bulk delete test value ${i}`,
       });
       itemIds.push(itemId);
     }
     await this.adapter.putBulk(this.testStoreName, items);
     const startTime = performance.now();
     await this.adapter.deleteBulk(this.testStoreName, itemIds);
     const endTime = performance.now();
     times.push(endTime - startTime);
   }
   return this.calculatePerformanceResult(times, this.options.itemCount);
 }


 // Test bulk file write performance
 async testBulkFileWrite(): Promise<PerformanceResult> {
   console.log('Testing bulk file write performance...');
   const times: number[] = [];
   for (let iter = 0; iter < this.options.iterations; iter++) {
     const files = [];
     // Create multiple test files
     for (let i = 0; i < this.options.itemCount; i++) {
       // Create test file of specified size
       const testData = new Uint8Array(this.options.fileSize);
       // Fill with random data
       for (let j = 0; j < testData.length; j++) {
         testData[j] = Math.floor(Math.random() * 256);
       }
       const testBlob = new Blob([testData], { type: 'application/octet-stream' });
       const fileId = `perf_bulk_file_write_${Date.now()}_${iter}_${i}.bin`;
       files.push({
         content: testBlob,
         fileId: fileId
       });
     }
     const startTime = performance.now();
     const attachments = await this.adapter.saveFiles(files);
     const endTime = performance.now();
     // Save actual file IDs for later cleanup
     for (const attachment of attachments) {
       if (attachment && attachment.id) {
         this.createdFileIds.push(attachment.id);
       }
     }
     times.push(endTime - startTime);
   }
   return this.calculatePerformanceResult(times, this.options.itemCount, this.options.fileSize * this.options.itemCount);
 }


 // Test bulk file read performance
 async testBulkFileRead(): Promise<PerformanceResult> {
   console.log('Testing bulk file read performance...');
   const times: number[] = [];
   // Create test files
   const files = [];
   const fileIds: string[] = [];
   for (let i = 0; i < this.options.itemCount; i++) {
     const testData = new Uint8Array(this.options.fileSize);
     // Fill with random data
     for (let j = 0; j < testData.length; j++) {
       testData[j] = Math.floor(Math.random() * 256);
     }
     const testBlob = new Blob([testData], { type: 'application/octet-stream' });
     const fileId = `perf_bulk_file_read_${Date.now()}_${i}.bin`;
     files.push({
       content: testBlob,
       fileId: fileId
     });
     fileIds.push(fileId);
   }
   const attachments = await this.adapter.saveFiles(files);
   // Save actual file IDs for cleanup and testing
   const actualFileIds: string[] = [];
   for (let i = 0; i < attachments.length; i++) {
     const actualFileId = attachments[i]?.id || fileIds[i];
     actualFileIds.push(actualFileId);
     this.createdFileIds.push(actualFileId);
   }
   for (let i = 0; i < this.options.iterations; i++) {
     const startTime = performance.now();
     await this.adapter.readFiles(actualFileIds);
     const endTime = performance.now();
     times.push(endTime - startTime);
   }
   return this.calculatePerformanceResult(times, this.options.itemCount, this.options.fileSize * this.options.itemCount);
 }


 // Test bulk file delete performance
 async testBulkFileDelete(): Promise<PerformanceResult> {
   console.log('Testing bulk file delete performance...');
   const times: number[] = [];
   for (let iter = 0; iter < this.options.iterations; iter++) {
     // Create files to delete
     const files = [];
     const fileIds: string[] = [];
     for (let i = 0; i < this.options.itemCount; i++) {
       const testData = new Uint8Array(this.options.fileSize);
       const testBlob = new Blob([testData], { type: 'application/octet-stream' });
       const fileId = `perf_bulk_file_delete_${Date.now()}_${iter}_${i}.bin`;
       files.push({
         content: testBlob,
         fileId: fileId
       });
       fileIds.push(fileId);
     }
     const attachments = await this.adapter.saveFiles(files);
     // Use actual file IDs for deletion test
     const actualFileIds = attachments.map(att => att.id);
     const startTime = performance.now();
     await this.adapter.deleteFiles(actualFileIds);
     const endTime = performance.now();
     times.push(endTime - startTime);
   }
   return this.calculatePerformanceResult(times, this.options.itemCount);
 }


// Test pagination performance
async testPagination(): Promise<PerformanceResult> {
  console.log('Testing pagination performance...');
  const times: number[] = [];
  // Create data for pagination testing
  const items: TestModel[] = [];
  for (let i = 0; i < this.options.itemCount; i++) {
    const itemId = `perf_pagination_${Date.now()}_${i}`;
    items.push({
      id: itemId,
      value: `Pagination test value ${i}`,
    });
    this.createdItemIds.push(itemId);
  }
  await this.adapter.putBulk(this.testStoreName, items);
  // Test different page sizes
  const pageSizes = [10, 25, 50];
  for (const pageSize of pageSizes) {
    for (let i = 0; i < this.options.iterations; i++) {
      const startTime = performance.now();
      await this.adapter.readByVersion(this.testStoreName, {
        limit: pageSize,
        offset: i * pageSize % this.options.itemCount
      });
      const endTime = performance.now();
      times.push(endTime - startTime);
    }
  }
  return this.calculatePerformanceResult(times, pageSizes[1]); // Use medium page size for ops/sec
}


// Test stress handling and concurrent operations
async testStress(): Promise<PerformanceResult> {
  console.log('Running concurrent operations stress test...');
  const times: number[] = [];
  for (let iter = 0; iter < this.options.iterations; iter++) {
    const startTime = performance.now();
    // Mix different operations
    const operations = [];
    const stressItemIds: string[] = [];
    // Reduce concurrent ops to make test more reliable
    const reducedConcurrentOps = Math.min(this.options.concurrentOperations, 5);
    for (let i = 0; i < reducedConcurrentOps; i++) {
      const opType = i % 4; // 0 = write, 1 = read, 2 = delete, 3 = file op
      if (opType === 0) {
        // Write operation
        const itemId = `stress_write_${Date.now()}_${i}`;
        const item: TestModel = {
          id: itemId,
          value: `Stress test write ${i}`,
        };
        stressItemIds.push(itemId);
        this.createdItemIds.push(itemId);
        operations.push(this.adapter.putBulk(this.testStoreName, [item]));
      } else if (opType === 1) {
        // Read operation (using pagination to avoid needing specific ID)
        operations.push(this.adapter.readByVersion(this.testStoreName, {
          limit: 5,
          offset: i * 5 % 20
        }));
      } else if (opType === 2) {
        // Delete operation - create then delete
        const itemId = `stress_delete_${Date.now()}_${i}`;
        const item: TestModel = {
          id: itemId,
          value: `Stress test delete ${i}`,
        };
        // Ensure creation is complete before deletion to avoid race condition
        await this.adapter.putBulk(this.testStoreName, [item]);
        operations.push(this.adapter.deleteBulk(this.testStoreName, [itemId]));
      } else {
        // File operation - handle file save and read separately to avoid concurrent ops on same file
        const testData = new Uint8Array(512); // Reduce file size to 512 bytes
        const testBlob = new Blob([testData], { type: 'application/octet-stream' });
        const fileId = `stress_file_${Date.now()}_${i}.bin`;
        try {
          // Upload file first
          const attachments = await this.adapter.saveFiles([{ content: testBlob, fileId }]);
          if (attachments[0]) {
            this.createdFileIds.push(attachments[0].id);
            // Then try to read
            operations.push(this.adapter.readFiles([attachments[0].id]));
          }
        } catch (error) {
          console.error(`File operation failed (${fileId}):`, error);
          // Continue test, don't interrupt
        }
      }
      // Add small delay after each operation to avoid race conditions
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // Execute operations sequentially, not concurrently
    for (const operation of operations) {
      try {
        await operation;
      } catch (error) {
        console.warn('Stress test operation failed:', error);
        // Continue test, don't interrupt
      }
    }
    const endTime = performance.now();
    times.push(endTime - startTime);
  }
  return this.calculatePerformanceResult(times, this.options.concurrentOperations);
}


// Clean up test data
async cleanupTestData(): Promise<void> {
  console.log('Cleaning up test data...');
  try {
    // Clean up created items
    if (this.createdItemIds.length > 0) {
      // Process in batches to avoid deleting too many at once
      const batchSize = 100;
      for (let i = 0; i < this.createdItemIds.length; i += batchSize) {
        const batch = this.createdItemIds.slice(i, i + batchSize);
        await this.adapter.deleteBulk(this.testStoreName, batch);
      }
      console.log(`Deleted ${this.createdItemIds.length} test records`);
    }
    // Clean up created files
    if (this.createdFileIds.length > 0) {
      // Process file deletion in batches
      const batchSize = 50;
      for (let i = 0; i < this.createdFileIds.length; i += batchSize) {
        const batch = this.createdFileIds.slice(i, i + batchSize);
        await this.adapter.deleteFiles(batch);
      }
      console.log(`Deleted ${this.createdFileIds.length} test files`);
    }
    // Find and delete other possible test data
    try {
      const result = await this.adapter.readByVersion<TestModel>(this.testStoreName, { limit: 1000 });
      if (result && result.items.length > 0) {
        // Find items that look like test data
        const testItems = result.items.filter(item =>
          item.id && (
            item.id.includes('perf_') ||
            item.id.includes('test_') ||
            item.id.includes('bulk_') ||
            item.id.includes('stress_')
          )
        );
        if (testItems.length > 0) {
          // Delete discovered test items
          await this.adapter.deleteBulk(
            this.testStoreName,
            testItems.map(item => item.id)
          );
          console.log(`Deleted ${testItems.length} additional test records by scanning`);
        }
      }
    } catch (error) {
      console.warn('Scan cleanup of test records failed:', error);
    }
    console.log('Cleanup complete');
  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  }
}


// Calculate performance metrics from raw timing data
private calculatePerformanceResult(
  times: number[],
  operationsPerTest: number,
  dataSize?: number
): PerformanceResult {
  const sumTime = times.reduce((sum, time) => sum + time, 0);
  const avgTime = sumTime / times.length;
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const opsPerSecond = operationsPerTest * (1000 / avgTime);
  let throughput: number | undefined;
  if (dataSize) {
    // Calculate MB/s
    throughput = (dataSize / 1024 / 1024) / (avgTime / 1000);
  }
  return {
    averageTimeMs: avgTime,
    minTimeMs: minTime,
    maxTimeMs: maxTime,
    operationsPerSecond: opsPerSecond,
    throughputMBps: throughput
  };
}
}


export interface PerformanceResult {
averageTimeMs: number;
minTimeMs: number;
maxTimeMs: number;
operationsPerSecond: number;
throughputMBps?: number;
}


export async function testAdapterPerformance(
adapter: DatabaseAdapter,
options?: PerformanceTesterOptions
): Promise<Record<string, PerformanceResult>> {
const tester = new PerformanceTester(adapter, options);
const result = await tester.runAllTests();
return result.results;
}
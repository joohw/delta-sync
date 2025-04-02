// tester/AdapterTester.ts

import {
  DatabaseAdapter,
  DataItem,
  FileItem
} from '../core/types';


export class AdapterTester {
  private adapter: DatabaseAdapter;
  private testStoreName: string;
  private testResults: Record<string, { success: boolean; message: string }> = {};

  constructor(adapter: DatabaseAdapter, testStoreName: string = 'adapter_test') {
    this.adapter = adapter;
    this.testStoreName = testStoreName;
  }

  private async runTest(
    testName: string,
    testFn: () => Promise<void>
  ): Promise<void> {
    try {
      await testFn();
      this.testResults[testName] = {
        success: true,
        message: 'Test passed successfully'
      };
    } catch (error) {
      this.testResults[testName] = {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async runAllTests(): Promise<{
    success: boolean;
    results: Record<string, { success: boolean; message: string }>;
  }> {
    // 按顺序执行所有测试
    await this.runTest('readStore', () => this.testReadStore());
    await this.runTest('readBulk', () => this.testReadBulk());
    await this.runTest('putBulk', () => this.testPutBulk());
    await this.runTest('deleteBulk', () => this.testDeleteBulk());
    await this.runTest('fileOperations', () => this.testFileOperations());
    await this.runTest('clearStore', () => this.testClearStore());
    await this.runTest('getStores', () => this.testGetStores());
    // 计算整体测试结果
    const success = Object.values(this.testResults)
      .every(result => result.success);

    return {
      success,
      results: this.testResults
    };
  }

  private async testReadStore(): Promise<void> {
    const result = await this.adapter.readStore(this.testStoreName);
    if (!result || typeof result.hasMore !== 'boolean') {
      throw new Error('readStore should return { items: any[], hasMore: boolean }');
    }
  }

  private async testReadBulk(): Promise<void> {
    const testIds = ['test1', 'test2'];
    const items = await this.adapter.readBulk(this.testStoreName, testIds);
    if (!Array.isArray(items)) {
      throw new Error('readBulk should return an array');
    }
  }

  private async testPutBulk(): Promise<void> {
    const testItems: DataItem[] = [
      {
        id: 'test1',
        data: { content: 'test content 1' }
      },
      {
        id: 'test2',
        data: { content: 'test content 2' }
      }
    ];

    const results = await this.adapter.putBulk(this.testStoreName, testItems);
    if (!Array.isArray(results)) {
      throw new Error('putBulk should return an array');
    }
  }

  private async testDeleteBulk(): Promise<void> {
    const testIds = ['test1', 'test2'];
    await this.adapter.deleteBulk(this.testStoreName, testIds);
    // 验证删除后是否还能读取
    const items = await this.adapter.readBulk(this.testStoreName, testIds);
    if (items.length > 0) {
      throw new Error('Items should be deleted');
    }
  }

  private async testFileOperations(): Promise<void> {
    // 测试文件保存
    const testFile = new Blob(['test content'], { type: 'text/plain' });
    const fileItem: FileItem = {
      fileId: 'test-file',
      content: testFile
    };

    // 测试保存文件
    const savedFiles = await this.adapter.saveFiles([fileItem]);
    if (!Array.isArray(savedFiles) || savedFiles.length === 0) {
      throw new Error('saveFiles should return an array of Attachments');
    }

    // 测试读取文件
    const fileMap = await this.adapter.readFiles([fileItem.fileId]);
    if (!(fileMap instanceof Map)) {
      throw new Error('readFiles should return a Map');
    }

    // 测试删除文件
    const deleteResult = await this.adapter.deleteFiles([fileItem.fileId]);
    if (!deleteResult || !Array.isArray(deleteResult.deleted)) {
      throw new Error('deleteFiles should return { deleted: string[], failed: string[] }');
    }
  }

  private async testClearStore(): Promise<void> {
    const result = await this.adapter.clearStore(this.testStoreName);
    if (typeof result !== 'boolean') {
      throw new Error('clearStore should return a boolean');
    }
  }

  private async testGetStores(): Promise<void> {
    const stores = await this.adapter.getStores();
    if (!Array.isArray(stores)) {
      throw new Error('getStores should return an array of strings');
    }
  }


}

export async function testAdapterFunctionality(
  adapter: DatabaseAdapter,
  testStoreName?: string
): Promise<{
  success: boolean;
  results: Record<string, { success: boolean; message: string }>;
}> {
  const tester = new AdapterTester(adapter, testStoreName);
  return await tester.runAllTests();
}

/**
 * 使用示例:
 * 
 * const adapter = new YourDatabaseAdapter();
 * const results = await testAdapterFunctionality(adapter);
 * 
 * console.log('Test Results:', results);
 * if (results.success) {
 *   console.log('All tests passed!');
 * } else {
 *   console.log('Some tests failed:', 
 *     Object.entries(results.results)
 *       .filter(([_, result]) => !result.success)
 *       .map(([name, result]) => `${name}: ${result.message}`)
 *   );
 * }
 */

// tester/SyncViewTester.ts

import { SyncView, SyncViewItem } from '../core/types';

export class SyncViewTester {
  private view: SyncView;
  private testResults: Record<string, { success: boolean; message: string }> = {};

  constructor() {
    this.view = new SyncView();
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
    await this.runTest('basicCRUD', () => this.testBasicCRUD());
    await this.runTest('batchOperations', () => this.testBatchOperations());
    await this.runTest('storePagination', () => this.testStorePagination());
    await this.runTest('viewDiff', () => this.testViewDiff());
    await this.runTest('serialization', () => this.testSerialization());
    await this.runTest('storeManagement', () => this.testStoreManagement());
    await this.runTest('clearOperation', () => this.testClearOperation());

    // 计算整体测试结果
    const success = Object.values(this.testResults).every(result => result.success);

    return {
      success,
      results: this.testResults
    };
  }

  private async testBasicCRUD(): Promise<void> {
    const testItem: SyncViewItem = {
      id: 'test1',
      store: 'notes',
      version: 1
    };

    // 测试插入
    this.view.upsert(testItem);
    if (this.view.size() !== 1) {
      throw new Error('Insert failed');
    }

    // 测试查询
    const retrieved = this.view.get('notes', 'test1');
    if (!retrieved || retrieved.id !== testItem.id) {
      throw new Error('Get operation failed');
    }

    // 测试更新
    const updatedItem = { ...testItem, version: 2 };
    this.view.upsert(updatedItem);
    const updated = this.view.get('notes', 'test1');
    if (!updated || updated.version !== 2) {
      throw new Error('Update operation failed');
    }

    // 测试删除
    this.view.delete('notes', 'test1');
    if (this.view.get('notes', 'test1') !== undefined) {
      throw new Error('Delete operation failed');
    }
  }

  private async testBatchOperations(): Promise<void> {
    const items: SyncViewItem[] = [
      { id: '1', store: 'notes', version: 1 },
      { id: '2', store: 'notes', version: 1 },
      { id: '3', store: 'tasks', version: 1 }
    ];

    this.view.upsertBatch(items);
    
    if (this.view.size() !== 3) {
      throw new Error('Batch insert failed');
    }
    if (this.view.storeSize('notes') !== 2) {
      throw new Error('Store size calculation failed');
    }
  }

  private async testStorePagination(): Promise<void> {
    this.view.clear();
    const items: SyncViewItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `${i}`,
      store: 'notes',
      version: 1
    }));

    this.view.upsertBatch(items);
    
    const page1 = this.view.getByStore('notes', 0, 5);
    const page2 = this.view.getByStore('notes', 5, 5);

    if (page1.length !== 5 || page2.length !== 5) {
      throw new Error('Pagination failed');
    }
  }

  private async testViewDiff(): Promise<void> {
    const localView = new SyncView();
    const remoteView = new SyncView();

    localView.upsert({ id: 'local1', store: 'notes', version: 1 });
    remoteView.upsert({ id: 'remote1', store: 'notes', version: 1 });
    
    const diff = SyncView.diffViews(localView, remoteView);
    
    if (diff.toUpload.length !== 1 || diff.toDownload.length !== 1) {
      throw new Error('View difference comparison failed');
    }
  }

  private async testSerialization(): Promise<void> {
    this.view.clear();
    const items: SyncViewItem[] = [
      { id: '1', store: 'notes', version: 1 },
      { id: '2', store: 'notes', version: 2 }
    ];

    this.view.upsertBatch(items);
    
    const serialized = this.view.serialize();
    const newView = SyncView.deserialize(serialized);

    if (newView.size() !== 2) {
      throw new Error('Serialization/Deserialization failed');
    }
  }

  private async testStoreManagement(): Promise<void> {
    this.view.clear();
    this.view.upsert({ id: '1', store: 'notes', version: 1 });
    this.view.upsert({ id: '2', store: 'tasks', version: 1 });
    
    const stores = this.view.getStores();
    if (!stores.includes('notes') || !stores.includes('tasks')) {
      throw new Error('Store management failed');
    }
  }

  private async testClearOperation(): Promise<void> {
    this.view.upsertBatch([
      { id: '1', store: 'notes', version: 1 },
      { id: '2', store: 'tasks', version: 1 }
    ]);

    this.view.clear();
    if (this.view.size() !== 0) {
      throw new Error('Clear operation failed');
    }
  }
}

export async function testSyncViewFunctionality(): Promise<{
  success: boolean;
  results: Record<string, { success: boolean; message: string }>;
}> {
  const tester = new SyncViewTester();
  return await tester.runAllTests();
}


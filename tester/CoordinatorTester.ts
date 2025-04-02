// tester/CoordinatorTester.ts

import { ICoordinator, SyncView } from '../core/types';
import { MemoryAdapter } from '../core/adapters';
import { Coordinator } from '../core/Coordinator';


interface TestData {
    id: string;
    content: string;
    timestamp?: number;
}


export class CoordinatorTester {
    private coordinator: ICoordinator;
    private memoryAdapter: MemoryAdapter;
    private testResults: Record<string, { success: boolean; message: string }> = {};

    constructor() {
        this.memoryAdapter = new MemoryAdapter();
        this.coordinator = new Coordinator(this.memoryAdapter);
    }


    private async runTest(
        testName: string,
        testFn: () => Promise<void>
    ): Promise<void> {
        try {
            await testFn();
            this.testResults[testName] = {
                success: true,
                message: '测试通过'
            };
        } catch (error) {
            this.testResults[testName] = {
                success: false,
                message: error instanceof Error ? error.message : '未知错误'
            };
            console.error(`Test '${testName}' failed:`, error);
        }
    }


    async runAllTests(): Promise<{
        success: boolean;
        results: Record<string, { success: boolean; message: string }>;
    }> {
        await this.runTest('初始化', () => this.testInitialization());
        await this.runTest('数据操作', () => this.testDataOperations());
        await this.runTest('查询操作', () => this.testQueryOperations());
        await this.runTest('变更通知', () => this.testChangeNotification());
        await this.runTest('同步操作', () => this.testSyncOperations());
        await this.runTest('并发操作', () => this.testConcurrency());
        await this.runTest('大数据量', () => this.testLargeDataset());
        await this.runTest('边界情况', () => this.testEdgeCases());
        const success = Object.values(this.testResults).every(result => result.success);
        return { success, results: this.testResults };
    }


    private async testInitialization(): Promise<void> {
        await this.coordinator.initSync?.();
        const view = await this.coordinator.getCurrentView();
        if (!(view instanceof SyncView)) {
            throw new Error('初始化失败：无效的SyncView');
        }
    }


    private async testDataOperations(): Promise<void> {
        const testStore = 'test_store';
        const testData: TestData[] = [
            { id: 'test1', content: 'test content 1' },
            { id: 'test2', content: 'test content 2' }
        ];
        // 测试写入
        const savedData = await this.coordinator.putBulk(testStore, testData);
        if (savedData.length !== testData.length) {
            throw new Error('数据写入失败');
        }
        // 测试读取
        const readData = await this.coordinator.readBulk<TestData>(testStore, [testData[0].id]);
        if (!readData[0] || readData[0].id !== testData[0].id) {
            throw new Error('数据读取失败');
        }
        // 测试删除
        await this.coordinator.deleteBulk(testStore, [testData[0].id]);
        const afterDelete = await this.coordinator.readBulk(testStore, [testData[0].id]);
        if (afterDelete.length !== 0) {
            throw new Error('数据删除失败');
        }
    }


    private async testQueryOperations(): Promise<void> {
        const testStore = 'query_test';
        // 清理测试数据
        const currentView = await this.coordinator.getCurrentView();
        await this.coordinator.deleteBulk(
            testStore,
            currentView.getByStore(testStore).map(item => item.id)
        );
        // 写入测试数据
        const testItems: TestData[] = Array.from({ length: 10 }, (_, i) => ({
            id: `query-test-${i}`,
            content: `content ${i}`,
            timestamp: Date.now() + i
        }));
        await this.coordinator.putBulk(testStore, testItems);
        // 测试基本查询
        const result = await this.coordinator.query<TestData>(testStore, { limit: 5 });
        if (result.items.length !== 5) {
            throw new Error(`查询数量错误: 期望5条，实际${result.items.length}条`);
        }
        // 测试分页
        const pageResult = await this.coordinator.query<TestData>(testStore, {
            offset: 3,
            limit: 3
        });
        if (pageResult.items.length !== 3) {
            throw new Error(`分页查询错误: 期望3条，实际${pageResult.items.length}条`);
        }
    }


    private async testChangeNotification(): Promise<void> {
        let notified = false;
        this.coordinator.onDataChanged(() => {
            notified = true;
        });
        await this.coordinator.putBulk('test_store', [{
            id: 'change-test',
            content: 'change test'
        }]);
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!notified) {
            throw new Error('变更通知失败');
        }
    }


    private async testSyncOperations(): Promise<void> {
        const changes: TestData[] = [{
            id: 'sync-test',
            content: 'sync test'
        }];
        await this.coordinator.applyChanges('sync_test', changes);
        const view = await this.coordinator.getCurrentView();
        const item = view.get('sync_test', 'sync-test');
        if (!item || item.id !== 'sync-test') {
            throw new Error('同步操作失败');
        }
    }


    private async testConcurrency(): Promise<void> {
        const operations = Array(10).fill(null).map((_, i) =>
            this.coordinator.putBulk('concurrent_test', [{
                id: `concurrent-${i}`,
                content: `concurrent content ${i}`
            }])
        );
        await Promise.all(operations);
    }


    private async testLargeDataset(): Promise<void> {
        const largeData = Array.from({ length: 1000 }, (_, i) => ({
            id: `large-${i}`,
            content: `large content ${i}`
        }));
        await this.coordinator.putBulk('large_test', largeData);
    }


    private async testEdgeCases(): Promise<void> {
        await this.coordinator.putBulk('edge_test', []);
        await this.coordinator.putBulk('edge_test', [{
            id: 'special-!@#$%^&*()',
            content: '!@#$%^&*()'
        }]);
        // 测试大对象
        const largeObject = {
            id: 'large-object',
            content: 'x'.repeat(1000000)
        };
        await this.coordinator.putBulk('edge_test', [largeObject]);
    }

}


export async function testCoordinatorFunctionality(): Promise<{
    success: boolean;
    results: Record<string, { success: boolean; message: string }>;
}> {
    const tester = new CoordinatorTester();
    return await tester.runAllTests();
}

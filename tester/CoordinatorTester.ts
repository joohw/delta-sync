// tester/CoordinatorTester.ts

import {
    ICoordinator,
    SyncView,
    DeltaModel,
    FileItem,
    DataChange,
    Attachment
} from '../core/types';

import { MemoryAdapter } from '../core/adapters';
import { Coordinator } from '../core/Coordinator';

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
        // 基础功能测试
        await this.runTest('初始化', () => this.testInitialization());
        await this.runTest('数据操作', () => this.testDataOperations());
        await this.runTest('文件操作', () => this.testFileOperations());
        await this.runTest('查询操作', () => this.testQueryOperations());
        await this.runTest('变更通知', () => this.testChangeNotification());
        await this.runTest('数据同步', () => this.testSyncOperations());

        // 压力测试
        await this.runTest('并发操作', () => this.testConcurrency());
        await this.runTest('大数据量', () => this.testLargeDataset());
        await this.runTest('边界情况', () => this.testEdgeCases());

        const success = Object.values(this.testResults)
            .every(result => result.success);

        return {
            success,
            results: this.testResults
        };
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

        // 测试数据准备
        const testData: DeltaModel[] = [{
            id: 'test1',
            store: testStore,
            data: { content: 'test content 1' },
            version: Date.now()
        }, {
            id: 'test2',
            store: testStore,
            data: { content: 'test content 2' },
            version: Date.now()
        }];

        // 测试写入
        const savedData = await this.coordinator.putBulk(testStore, testData);
        if (savedData.length !== testData.length) {
            throw new Error('数据写入失败');
        }

        // 测试读取
        const readData = await this.coordinator.readBulk(testStore, [testData[0].id]);
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

    private async testFileOperations(): Promise<void> {
        // 创建测试文件
        const testContent = 'Hello, World!';
        const testFile = new Blob([testContent], { type: 'text/plain' });
        const fileItem: FileItem = {
            fileId: 'test-file-1',
            content: testFile
        };

        // 测试文件上传
        const attachments = await this.coordinator.uploadFiles([fileItem]);
        if (!attachments[0] || attachments[0].id !== fileItem.fileId) {
            throw new Error('文件上传失败');
        }

        // 测试文件下载
        const downloadedFiles = await this.coordinator.downloadFiles([fileItem.fileId]);
        const downloadedContent = downloadedFiles.get(fileItem.fileId);
        if (!downloadedContent) {
            throw new Error('文件下载失败');
        }

        // 测试文件删除
        await this.coordinator.deleteFiles([fileItem.fileId]);
        const afterDelete = await this.coordinator.downloadFiles([fileItem.fileId]);
        if (afterDelete.get(fileItem.fileId) !== null) {
            throw new Error('文件删除失败');
        }
    }

    private async testQueryOperations(): Promise<void> {
        const testStore = 'query_test';

        // 写入测试数据
        const testData = Array.from({ length: 10 }, (_, i) => ({
            id: `query-test-${i}`,
            store: testStore,
            data: { index: i },
            version: Date.now() + i
        }));

        await this.coordinator.putBulk(testStore, testData);

        // 测试分页查询
        const result = await this.coordinator.querySync(testStore, {
            limit: 5,
            offset: 0
        });

        if (!result.items || result.items.length !== 5) {
            throw new Error('分页查询失败');
        }
    }

    private async testChangeNotification(): Promise<void> {
        let notified = false;
        this.coordinator.onDataChanged(() => {
            notified = true;
        });

        // 触发数据变更
        await this.coordinator.putBulk('test_store', [{
            id: 'change-test',
            store: 'test_store',
            data: { content: 'change test' },
            version: Date.now()
        }]);

        // 等待通知
        await new Promise(resolve => setTimeout(resolve, 100));

        if (!notified) {
            throw new Error('变更通知失败');
        }
    }

    private async testSyncOperations(): Promise<void> {
        const changes: DataChange[] = [{
            id: 'sync-test',
            store: 'sync_test',
            data: { content: 'sync test' },
            version: Date.now(),
            operation: 'put'
        }];

        await this.coordinator.applyChanges(changes);

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
                store: 'concurrent_test',
                data: { index: i },
                version: Date.now()
            }])
        );

        await Promise.all(operations);
    }

    private async testLargeDataset(): Promise<void> {
        const largeData = Array.from({ length: 1000 }, (_, i) => ({
            id: `large-${i}`,
            store: 'large_test',
            data: { index: i },
            version: Date.now()
        }));

        await this.coordinator.putBulk('large_test', largeData);
    }

    private async testEdgeCases(): Promise<void> {
        // 测试空数据
        await this.coordinator.putBulk('edge_test', []);

        // 测试特殊字符
        await this.coordinator.putBulk('edge_test', [{
            id: 'special-!@#$%^&*()',
            store: 'edge_test',
            data: { content: '!@#$%^&*()' },
            version: Date.now()
        }]);

        // 测试大对象
        const largeObject = {
            id: 'large-object',
            store: 'edge_test',
            data: { content: 'x'.repeat(1000000) },
            version: Date.now()
        };
        await this.coordinator.putBulk('edge_test', [largeObject]);
    }
}

/**
 * 运行协调器测试
 */
export async function testCoordinatorFunctionality(): Promise<{
    success: boolean;
    results: Record<string, { success: boolean; message: string }>;
}> {
    const tester = new CoordinatorTester();
    return await tester.runAllTests();
}

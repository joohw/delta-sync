// tester/EngineTester.ts

import { SyncEngine } from '../core/SyncEngine';
import { MemoryAdapter } from '../core/adapters';
import { DataItem } from '../core/types';

export class EngineTester {
    private localEngine: SyncEngine;
    private cloudEngine: SyncEngine;
    private testResults: Record<string, { success: boolean; message: string }> = {};

    constructor() {
        this.localEngine = new SyncEngine(new MemoryAdapter());
        this.cloudEngine = new SyncEngine(new MemoryAdapter());
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
        // 先初始化两个引擎
        await this.localEngine.initialize();
        await this.cloudEngine.initialize();

        // 设置云端适配器
        await this.localEngine.setCloudAdapter(await this.cloudEngine.getlocalAdapter());

        // 运行测试
        await this.runTest('基础数据同步', () => this.testBasicSync());
        await this.runTest('冲突数据同步', () => this.testConflictSync());
        await this.runTest('批量数据同步', () => this.testBatchSync());
        await this.runTest('文件同步', () => this.testFileSync());
        await this.runTest('删除同步', () => this.testDeleteSync());

        const success = Object.values(this.testResults)
            .every(result => result.success);

        return {
            success,
            results: this.testResults
        };
    }

    private async testBasicSync(): Promise<void> {
        const testStore = 'test_store';
        const testDataItem: DataItem = {
            id: 'test-1',
            data: { name: 'test', value: 123 }
        };

        // 在本地保存数据
        const [savedItem] = await this.localEngine.save(testStore, testDataItem);

        // 执行同步
        const syncResult = await this.localEngine.sync();
        if (!syncResult.success) {
            throw new Error(`同步失败: ${syncResult.error}`);
        }

        // 通过云端引擎查询数据验证
        const cloudQuery = await this.cloudEngine.query(testStore);
        const cloudItem = cloudQuery.items[0];

        if (!cloudItem || cloudItem.name !== testDataItem.data.name) {
            throw new Error('数据同步验证失败');
        }
    }

    private async testConflictSync(): Promise<void> {
        const testStore = 'conflict_store';
        const conflictId = 'conflict-1';

        // 在本地创建数据
        const localDataItem: DataItem = {
            id: conflictId,
            data: { name: 'local', value: 1 }
        };
        await this.localEngine.save(testStore, localDataItem);

        // 在云端创建同一条数据的不同版本
        const cloudDataItem: DataItem = {
            id: conflictId,
            data: { name: 'cloud', value: 2 }
        };
        await this.cloudEngine.save(testStore, cloudDataItem);

        // 执行同步
        await this.localEngine.sync();

        // 查询本地和云端数据
        const localQuery = await this.localEngine.query(testStore);
        const cloudQuery = await this.cloudEngine.query(testStore);

        // 验证数据一致性
        if (JSON.stringify(localQuery.items) !== JSON.stringify(cloudQuery.items)) {
            throw new Error('冲突解决后数据不一致');
        }
    }

    private async testBatchSync(): Promise<void> {
        const testStore = 'batch_store';
        const batchDataItems: DataItem[] = Array.from(
            { length: 10 },
            (_, i) => ({
                id: `batch-${i}`,
                data: { name: `item_${i}`, value: i }
            })
        );

        // 批量保存数据
        await this.localEngine.save(testStore, batchDataItems);

        // 执行同步
        await this.localEngine.sync();

        // 验证云端数据
        const cloudQuery = await this.cloudEngine.query(testStore);
        if (cloudQuery.items.length !== batchDataItems.length) {
            throw new Error('批量数据同步不完整');
        }

        // 验证数据内容
        const allMatch = batchDataItems.every(item =>
            cloudQuery.items.some(cloudItem =>
                cloudItem.name === item.data.name &&
                cloudItem.value === item.data.value
            )
        );

        if (!allMatch) {
            throw new Error('批量数据内容不匹配');
        }
    }

    private async testFileSync(): Promise<void> {
        const fileId = 'test-file';
        const content = 'Hello, World!';
        const file = new Blob([content], { type: 'text/plain' });

        // 在本地保存文件
        const attachment = await this.localEngine.saveFile(
            fileId,
            file,
            'test.txt',
            'text/plain'
        );

        // 执行同步
        await this.localEngine.sync();

        // 从云端读取文件验证
        const cloudFile = await this.cloudEngine.readFile(fileId);
        if (!cloudFile) {
            throw new Error('文件同步失败');
        }

        // 验证文件内容
        const cloudContent = await new Response(cloudFile).text();
        if (cloudContent !== content) {
            throw new Error('文件内容不匹配');
        }
    }

    private async testDeleteSync(): Promise<void> {
        const testStore = 'delete_store';
        const testDataItem: DataItem = {
            id: 'delete-1',
            data: { name: 'to_delete', value: 999 }
        };

        // 先创建数据并同步到云端
        await this.localEngine.save(testStore, testDataItem);
        await this.localEngine.sync();

        // 在本地删除数据
        await this.localEngine.delete(testStore, testDataItem.id);
        await this.localEngine.sync();

        // 验证云端数据也被删除
        const cloudQuery = await this.cloudEngine.query(testStore);
        if (cloudQuery.items.length !== 0) {
            throw new Error('删除操作同步失败');
        }
    }
}

/**
 * 运行同步引擎测试
 */
export async function testEngineFunctionality(): Promise<{
    success: boolean;
    results: Record<string, { success: boolean; message: string }>;
}> {
    const tester = new EngineTester();
    return await tester.runAllTests();
}
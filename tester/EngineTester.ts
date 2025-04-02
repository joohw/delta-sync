// tester/EngineTester.ts

import { ISyncEngine } from '../core/types';
import { MemoryAdapter } from '../core/adapters';
import { SyncEngine } from '../core/SyncEngine';


export class EngineTester {
    private engine1: ISyncEngine;
    private engine2: ISyncEngine;
    private testResults: Record<string, { success: boolean; message: string }> = {};

    constructor() {
        const adapter1 = new MemoryAdapter();
        const adapter2 = new MemoryAdapter();
        this.engine1 = new SyncEngine(adapter1);
        this.engine2 = new SyncEngine(adapter2);
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


    private async testBasicSync(): Promise<void> {
        await this.setupTestEnvironment();
        // 在engine1中保存数据
        const testData = { id: 'test1', value: 'test value' };
        await this.engine1.save('test_store', testData);
        // 执行同步
        await this.engine1.push();
        await this.engine2.pull();
        // 验证数据同步
        const result = await this.engine2.query<typeof testData>('test_store');
        if (!result.items.length || !result.items.some(item => item.id === testData.id)) {
            throw new Error('数据同步验证失败');
        }
    }


    private async testConflictSync(): Promise<void> {
        const testStore = 'conflict_test';
        const baseData = { id: 'conflict1', content: 'original' };

        // 初始化相同的数据
        await this.engine1.save(testStore, baseData);
        await this.engine1.push();
        await this.engine2.pull();

        // 在两个引擎中进行不同的修改
        await this.engine1.save(testStore, { ...baseData, content: 'modified by engine1' });
        await this.engine2.save(testStore, { ...baseData, content: 'modified by engine2' });

        // 执行同步
        await this.engine1.push();
        await this.engine2.sync();
        await this.engine1.pull();

        // 验证冲突解决
        const result1 = await this.engine1.query<typeof baseData>(testStore);
        const result2 = await this.engine2.query<typeof baseData>(testStore);

        if (result1.items[0].content !== result2.items[0].content) {
            throw new Error('冲突解决后数据不一致');
        }
    }


    private async testBatchSync(): Promise<void> {
        const testStore = 'batch_test';
        const items = Array.from({ length: 100 }, (_, i) => ({
            id: `batch-${i}`,
            timestamp: Date.now() + i
        }));
        // 批量保存数据
        await this.engine1.save(testStore, items);
        // 执行同步
        await this.engine1.push();
        await this.engine2.pull();
        // 验证同步结果
        const result = await this.engine2.query(testStore, { limit: 200 });
        if (result.items.length !== items.length) {
            throw new Error(`批量数据同步不完整: 期望 ${items.length}, 实际 ${result.items.length}`);
        }
        // 验证数据完整性：只检查 id 的存在性
        const allItemsPresent = items.every(item => 
            result.items.some(syncedItem => syncedItem.id === item.id)
        );
        if (!allItemsPresent) {
            throw new Error('批量数据同步不完整');
        }
    }


    private async setupTestEnvironment(): Promise<void> {
        await this.engine1.initialize();
        await this.engine2.initialize();
        // 确保使用新的云端适配器
        const cloudAdapter = new MemoryAdapter();
        await this.engine1.setCloudAdapter(cloudAdapter);
        await this.engine2.setCloudAdapter(cloudAdapter);
    }


    async runAllTests(): Promise<{
        success: boolean;
        results: Record<string, { success: boolean; message: string }>;
    }> {
        // 初始化测试环境
        await this.setupTestEnvironment();
        // 运行测试
        await this.runTest('基础数据同步', () => this.testBasicSync());
        await this.runTest('冲突数据同步', () => this.testConflictSync());
        await this.runTest('批量数据同步', () => this.testBatchSync());
        const success = Object.values(this.testResults).every(result => result.success);
        return { success, results: this.testResults };
    }
}


export async function testEngineFunctionality(): Promise<{
    success: boolean;
    results: Record<string, { success: boolean; message: string }>;
}> {
    const tester = new EngineTester();
    return await tester.runAllTests();
}

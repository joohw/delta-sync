// /test/index.ts

import { MemoryAdapter } from '../core/adapters';
import { DatabaseAdapter } from '../core/types';
import { testAdapterFunctionality } from '../tester/AdapterTester';
import { testCoordinatorFunctionality } from '../tester/CoordinatorTester';
import { testEngineFunctionality } from '../tester/EngineTester';
import {testSyncViewFunctionality} from '../tester/SyncViewTester';




export async function testSyncView(): Promise<{
    success: boolean;
    results: Record<string, { success: boolean; message: string }>;
}> {
    return await testSyncViewFunctionality();
}


/**
 * 测试适配器功能
 */
export async function testAdapter(
    adapter: DatabaseAdapter,
    options?: {
        storeName?: string,
        autoCleanup?: boolean
    }
): Promise<{
    success: boolean;
    results: Record<string, { success: boolean; message: string }>;
}> {
    return await testAdapterFunctionality(adapter, options?.storeName);
}

/**
 * 测试协调器功能
 */
export async function testCoordinator(): Promise<{
    success: boolean;
    results: Record<string, { success: boolean; message: string }>;
}> {
    return await testCoordinatorFunctionality();
}

/**
 * 测试同步引擎功能
 */
export async function testEngine(): Promise<{
    success: boolean;
    results: Record<string, { success: boolean; message: string }>;
}> {
    return await testEngineFunctionality();
}




/**
 * 主测试函数
 */
export async function runTests(): Promise<boolean> {
    const memoryAdapter = new MemoryAdapter();
    
    // 运行所有测试
    const results = await Promise.all([
        testSyncView(),
        testAdapter(memoryAdapter),
        testCoordinator(),
        testEngine(),
    ]);

    // 返回总体结果
    return results.every(result => result.success);
}


// 直接执行测试
runTests().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error(error);
    process.exit(1);
});


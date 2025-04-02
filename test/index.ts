// /test/index.ts

import { MemoryAdapter } from '../core/adapters';
import { DatabaseAdapter } from '../core/types';
import { testAdapterFunctionality } from '../tester/AdapterTester';
import { testCoordinatorFunctionality } from '../tester/CoordinatorTester';

/**
 * 测试适配器功能
 */
export async function testAdapter(
    adapter: DatabaseAdapter,
    options?: {
        storeName?: string,
        autoCleanup?: boolean
    }
): Promise<boolean> {
    const result = await testAdapterFunctionality(adapter, options?.storeName);
    return result.success;
}

/**
 * 测试协调器功能
 */
export async function testCoordinator(): Promise<boolean> {
    const result = await testCoordinatorFunctionality();
    return result.success;
}

/**
 * 打印测试结果
 */
function printTestResults(
    name: string,
    results: Record<string, { success: boolean; message: string }>
) {
    console.log(`\n=== ${name} 测试结果 ===`);
    
    const failed = Object.entries(results)
        .filter(([_, result]) => !result.success);
    
    const passed = Object.entries(results)
        .filter(([_, result]) => result.success);

    // 打印通过的测试
    console.log(`\n✅ 通过 (${passed.length})`);
    passed.forEach(([name]) => {
        console.log(`  - ${name}`);
    });

    // 打印失败的测试
    if (failed.length > 0) {
        console.log(`\n❌ 失败 (${failed.length})`);
        failed.forEach(([name, result]) => {
            console.log(`  - ${name}: ${result.message}`);
        });
    }
}

/**
 * 主测试函数
 */
async function main() {
    console.log('开始运行测试...\n');
    
    // 测试内存适配器
    const memoryAdapter = new MemoryAdapter();
    console.log('测试内存适配器...');
    const adapterResult = await testAdapterFunctionality(memoryAdapter);
    printTestResults('适配器', adapterResult.results);
    
    // 测试协调器
    console.log('\n测试协调器...');
    const coordinatorResult = await testCoordinatorFunctionality();
    printTestResults('协调器', coordinatorResult.results);

    // 输出总体结果
    console.log('\n=== 测试总结 ===');
    const allPassed = adapterResult.success && coordinatorResult.success;
    
    if (allPassed) {
        console.log('✅ 所有测试通过！');
    } else {
        console.log('❌ 部分测试失败');
        process.exit(1);
    }
}

// 仅在直接运行时执行测试
if (require.main === module) {
    main().catch(error => {
        console.error('测试执行失败:', error);
        process.exit(1);
    });
}

// 导出测试功能
export const testing = {
    testAdapter,
    testCoordinator,
    runAll: main
};

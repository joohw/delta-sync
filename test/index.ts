// /test/index.ts

import { MemoryAdapter } from '../adapters';
import { DatabaseAdapter } from '../core/types';
import { testAdapterFunctionality } from '../tester/FunctionTester';
import { testAdapterPerformance } from '../tester/PerformanceTester';


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



async function runPerformanceTests(adapter: DatabaseAdapter) {
    console.log('Testing adapter performance...');
    const results = await testAdapterPerformance(adapter, {
        itemCount: 50,
        iterations: 2,
        fileSize: 1000 * 1024,
        verbose: true
    });
    console.log('\nPerformance Results Summary:');
    console.log('Operation | Average Time (ms) | Operations/sec');
    console.log('------------------------------------------------');
    for (const testName of Object.keys(results)) {
        const avgTime = results[testName].averageTimeMs.toFixed(2);
        const opsPerSec = results[testName].operationsPerSecond.toFixed(2);
        console.log(`${testName} | ${avgTime} | ${opsPerSec}`);
    }
    const avgTime = Object.values(results).reduce(
        (sum, result) => sum + result.averageTimeMs, 0
    ) / Object.keys(results).length;
    console.log(`\nOverall average operation time: ${avgTime.toFixed(2)}ms`);
    return results;
}


// 创建内存适配器实例
async function main() {
    const memoryAdapter = new MemoryAdapter();
    console.log('=== Running Functionality Tests on MemoryAdapter ===');
    const functionalityResult = await testAdapter(memoryAdapter, {
        storeName: 'memory_test',
        autoCleanup: true
    });
    console.log('Functionality tests result:', functionalityResult ? 'PASSED' : 'FAILED');
    if (functionalityResult) {
        console.log('\n=== Running Performance Tests on MemoryAdapter ===');
        await runPerformanceTests(memoryAdapter);
    }
}



main().catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
});
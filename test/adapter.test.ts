// tests/adapter.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseAdapter } from '../core/types'
import { MemoryAdapter } from '../core/adapters'

describe('DatabaseAdapter Tests', () => {
    let adapter: DatabaseAdapter
    const TEST_STORE = 'adapter_test'

    beforeEach(() => {
        // 每个测试前初始化一个新的适配器
        adapter = new MemoryAdapter()
    })

    describe('Basic Operations', () => {
        it('should read store correctly', async () => {
            const result = await adapter.readStore(TEST_STORE)
            expect(result).toBeDefined()
            expect(typeof result.hasMore).toBe('boolean')
            expect(Array.isArray(result.items)).toBe(true)
        })

        it('should read bulk items', async () => {
            const testIds = ['test1', 'test2']
            const items = await adapter.readBulk(TEST_STORE, testIds)
            expect(Array.isArray(items)).toBe(true)
        })

        it('should put bulk items', async () => {
            const testItems = [
                {
                    id: 'test1',
                    data: { content: 'test content 1' }
                },
                {
                    id: 'test2',
                    data: { content: 'test content 2' }
                }
            ]

            const results = await adapter.putBulk(TEST_STORE, testItems)
            expect(Array.isArray(results)).toBe(true)
            
            // 验证写入的数据
            const savedItems = await adapter.readBulk(TEST_STORE, ['test1', 'test2'])
            expect(savedItems).toHaveLength(2)
            expect(savedItems).toEqual(expect.arrayContaining(testItems))
        })

        it('should delete bulk items', async () => {
            // 先写入一些数据
            const testItems = [
                {
                    id: 'test1',
                    data: { content: 'test content 1' }
                },
                {
                    id: 'test2',
                    data: { content: 'test content 2' }
                }
            ]
            await adapter.putBulk(TEST_STORE, testItems)

            // 测试删除
            const testIds = ['test1', 'test2']
            await adapter.deleteBulk(TEST_STORE, testIds)

            // 验证删除结果
            const items = await adapter.readBulk(TEST_STORE, testIds)
            expect(items).toHaveLength(0)
        })

        it('should clear store', async () => {
            // 先写入一些数据
            const testItems = [
                {
                    id: 'test1',
                    data: { content: 'test content 1' }
                }
            ]
            await adapter.putBulk(TEST_STORE, testItems)

            // 测试清空存储
            const result = await adapter.clearStore(TEST_STORE)
            expect(typeof result).toBe('boolean')
            expect(result).toBe(true)

            // 验证存储已清空
            const { items } = await adapter.readStore(TEST_STORE)
            expect(items).toHaveLength(0)
        })

        it('should get stores list', async () => {
            const stores = await adapter.getStores()
            expect(Array.isArray(stores)).toBe(true)
            expect(stores.every(store => typeof store === 'string')).toBe(true)
        })
    })

    describe('Error Handling', () => {
        it('should handle invalid store name', async () => {
            await expect(adapter.readStore('')).rejects.toThrow()
        })

        it('should handle invalid ids in readBulk', async () => {
            await expect(adapter.readBulk(TEST_STORE, [])).resolves.toHaveLength(0)
        })

        it('should handle invalid items in putBulk', async () => {
            // @ts-expect-error 测试无效数据
            await expect(adapter.putBulk(TEST_STORE, [{ invalid: true }])).rejects.toThrow()
        })
    })

    describe('Performance', () => {
        it('should handle large bulk operations', async () => {
            const largeDataSet = Array.from({ length: 1000 }, (_, i) => ({
                id: `perf-${i}`,
                data: { content: `content ${i}` }
            }))
    
            // 测试批量写入性能
            const startTime = Date.now()
            await adapter.putBulk(TEST_STORE, largeDataSet)
            const endTime = Date.now()
    
            // 假设我们期望 1000 条数据的写入时间不超过 1 秒
            expect(endTime - startTime).toBeLessThan(1000)
    
            // 使用多次查询来验证所有数据
            let allItems: any[] = [];
            let offset = 0;
            const limit = 200;
            let hasMore = true;
    
            while (hasMore) {
                const result = await adapter.readStore(TEST_STORE, limit, offset);
                allItems = allItems.concat(result.items);
                hasMore = result.hasMore;
                offset += limit;
            }
    
            // 验证数据完整性
            expect(allItems.length).toBe(largeDataSet.length)
            
            // 验证数据内容
            const sortedItems = allItems.sort((a, b) => 
                Number(a.id.split('-')[1]) - Number(b.id.split('-')[1])
            );
            
            expect(sortedItems).toEqual(largeDataSet)
        })
    
        it('should respect pagination in readStore', async () => {
            // 写入 150 条测试数据
            const testData = Array.from({ length: 150 }, (_, i) => ({
                id: `page-${i}`,
                data: { value: i }
            }));
            await adapter.putBulk(TEST_STORE, testData);
    
            // 测试第一页
            const page1 = await adapter.readStore(TEST_STORE, 100, 0);
            expect(page1.items.length).toBe(100);
            expect(page1.hasMore).toBe(true);
    
            // 测试第二页
            const page2 = await adapter.readStore(TEST_STORE, 100, 100);
            expect(page2.items.length).toBe(50);
            expect(page2.hasMore).toBe(false);
    
            // 验证总数据量
            const allItems = [...page1.items, ...page2.items];
            expect(allItems.length).toBe(150);
        })
    
        it('should handle reading all data with custom limit', async () => {
            // 写入 500 条测试数据
            const testData = Array.from({ length: 500 }, (_, i) => ({
                id: `all-${i}`,
                data: { value: i }
            }));
            await adapter.putBulk(TEST_STORE, testData);
    
            // 使用较大的 limit 一次性读取所有数据
            const result = await adapter.readStore(TEST_STORE, 1000, 0);
            expect(result.items.length).toBe(500);
            expect(result.hasMore).toBe(false);
        })
    })
    
})

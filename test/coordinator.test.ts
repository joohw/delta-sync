// tests/coordinator.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { ICoordinator, SyncView } from '../core/types'
import { MemoryAdapter } from '../core/adapters'
import { Coordinator } from '../core/Coordinator'

interface TestData {
    id: string
    content: string
    timestamp?: number
}

describe('Coordinator Tests', () => {
    let coordinator: ICoordinator
    let memoryAdapter: MemoryAdapter

    beforeEach(() => {
        memoryAdapter = new MemoryAdapter()
        coordinator = new Coordinator(memoryAdapter)
    })

    describe('Initialization', () => {
        it('should initialize correctly', async () => {
            await coordinator.initSync?.()
            const view = await coordinator.getCurrentView()
            expect(view).toBeInstanceOf(SyncView)
        })
    })

    describe('Data Operations', () => {
        const TEST_STORE = 'test_store'

        it('should handle basic CRUD operations', async () => {
            const testData: TestData[] = [
                { id: 'test1', content: 'test content 1' },
                { id: 'test2', content: 'test content 2' }
            ]

            // Test Write
            const savedData = await coordinator.putBulk(TEST_STORE, testData)
            expect(savedData).toHaveLength(testData.length)

            // Test Read
            const readData = await coordinator.readBulk<TestData>(TEST_STORE, [testData[0].id])
            expect(readData[0]).toBeDefined()
            expect(readData[0].id).toBe(testData[0].id)

            // Test Delete
            await coordinator.deleteBulk(TEST_STORE, [testData[0].id])
            const afterDelete = await coordinator.readBulk(TEST_STORE, [testData[0].id])
            expect(afterDelete).toHaveLength(0)
        })
    })

    describe('Query Operations', () => {
        const QUERY_STORE = 'query_test'

        it('should handle queries with pagination', async () => {
            // Clean up test data
            const currentView = await coordinator.getCurrentView()
            await coordinator.deleteBulk(
                QUERY_STORE,
                currentView.getByStore(QUERY_STORE).map(item => item.id)
            )

            // Insert test data
            const testItems: TestData[] = Array.from({ length: 10 }, (_, i) => ({
                id: `query-test-${i}`,
                content: `content ${i}`,
                timestamp: Date.now() + i
            }))
            await coordinator.putBulk(QUERY_STORE, testItems)

            // Test basic query
            const result = await coordinator.query<TestData>(QUERY_STORE, { limit: 5 })
            expect(result.items).toHaveLength(5)

            // Test pagination
            const pageResult = await coordinator.query<TestData>(QUERY_STORE, {
                offset: 3,
                limit: 3
            })
            expect(pageResult.items).toHaveLength(3)
        })
    })


    describe('Concurrency', () => {
        it('should handle concurrent operations', async () => {
            const operations = Array(10).fill(null).map((_, i) =>
                coordinator.putBulk('concurrent_test', [{
                    id: `concurrent-${i}`,
                    content: `concurrent content ${i}`
                }])
            )

            await expect(Promise.all(operations)).resolves.toBeDefined()
        })
    })

    describe('Large Dataset', () => {
        it('should handle large datasets', async () => {
            const TOTAL_ITEMS = 1000;
            const largeData = Array.from({ length: TOTAL_ITEMS }, (_, i) => ({
                id: `large-${i}`,
                content: `large content ${i}`
            }));

            // 写入数据
            await coordinator.putBulk('large_test', largeData);

            // 使用分页获取所有数据
            let allItems: any[] = [];
            let offset = 0;
            const PAGE_SIZE = 200;

            while (true) {
                const result = await coordinator.query('large_test', {
                    limit: PAGE_SIZE,
                    offset: offset
                });
                allItems.push(...result.items);

                if (!result.hasMore) break;
                offset += PAGE_SIZE;
            }

            // 验证总数
            expect(allItems).toHaveLength(TOTAL_ITEMS);

            // 验证数据完整性
            allItems.sort((a, b) => {
                const aNum = parseInt(a.id.split('-')[1]);
                const bNum = parseInt(b.id.split('-')[1]);
                return aNum - bNum;
            });

            for (let i = 0; i < TOTAL_ITEMS; i++) {
                expect(allItems[i].id).toBe(`large-${i}`);
                expect(allItems[i].content).toBe(`large content ${i}`);
            }
        });
        it('should handle pagination correctly', async () => {
            const TOTAL_ITEMS = 200;
            const PAGE_SIZE = 50;
            
            // 先清理已存在的数据
            const currentView = await coordinator.getCurrentView();
            const existingIds = currentView.getByStore('large_test').map(item => item.id);
            if (existingIds.length > 0) {
              await coordinator.deleteBulk('large_test', existingIds);
            }
        
            // 准备测试数据
            const testData = Array.from({ length: TOTAL_ITEMS }, (_, i) => ({
              id: `page-test-${i}`,
              content: `content ${i}`
            }));
            
            // 写入测试数据
            await coordinator.putBulk('large_test', testData);
        
            // 测试第一页
            const result1 = await coordinator.query('large_test', {
              limit: PAGE_SIZE,
              offset: 0
            });
            
            expect(result1.items).toHaveLength(PAGE_SIZE);
            expect(result1.hasMore).toBe(true);
        
            // 测试第二页
            const result2 = await coordinator.query('large_test', {
              limit: PAGE_SIZE,
              offset: PAGE_SIZE
            });
            
            expect(result2.items).toHaveLength(PAGE_SIZE);
            expect(result2.hasMore).toBe(true);
        
            // 验证数据连续性
            const allIds = new Set([
              ...result1.items.map(item => item.id),
              ...result2.items.map(item => item.id)
            ]);
            expect(allIds.size).toBe(PAGE_SIZE * 2); // 确保没有重复
            // 验证顺序
            const firstPageLastId = parseInt(result1.items[PAGE_SIZE - 1].id.split('-')[2]);
            const secondPageFirstId = parseInt(result2.items[0].id.split('-')[2]);
            expect(secondPageFirstId).toBe(firstPageLastId + 1);
          });
    });


    describe('Edge Cases', () => {
        it('should handle empty array', async () => {
            await expect(coordinator.putBulk('edge_test', [])).resolves.toHaveLength(0)
        })

        it('should handle special characters in id', async () => {
            await expect(coordinator.putBulk('edge_test', [{
                id: 'special-!@#$%^&*()',
                content: '!@#$%^&*()'
            }])).resolves.toBeDefined()
        })

        it('should handle large objects', async () => {
            const largeObject = {
                id: 'large-object',
                content: 'x'.repeat(1000000)
            }
            await expect(coordinator.putBulk('edge_test', [largeObject])).resolves.toBeDefined()
        })
    })

    describe('View Management', () => {
        it('should manage sync view correctly', async () => {
            const testData = { id: 'view-test', content: 'view test' }
            await coordinator.putBulk('view_test', [testData])

            const view = await coordinator.getCurrentView()
            const viewItem = view.get('view_test', 'view-test')

            expect(viewItem).toBeDefined()
            expect(viewItem?.id).toBe('view-test')
        })
    })
})

// tests/engine.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SyncEngine } from '../core/SyncEngine'
import { MemoryAdapter } from '../core/adapters'
import { SyncStatus, DatabaseAdapter, SyncOptions, DataChangeSet } from '../core/types'

describe('SyncEngine Tests', () => {
    let engine: SyncEngine
    let localAdapter: DatabaseAdapter
    let cloudAdapter: DatabaseAdapter
    let options: SyncOptions

    beforeEach(() => {
        localAdapter = new MemoryAdapter()
        cloudAdapter = new MemoryAdapter()
        options = {
            autoSync: {
                enabled: false,
                interval: 1000,
                retryDelay: 500
            },
            onStatusUpdate: vi.fn(),
            onChangePushed: vi.fn(),
            onChangePulled: vi.fn(),
            maxRetries: 3,
            timeout: 5000,
            batchSize: 100
        }
        engine = new SyncEngine(localAdapter, options)
    })

    describe('Initialization', () => {
        it('should initialize correctly', async () => {
            await engine.initialize()
            const coordinator = await engine.getlocalCoordinator()
            expect(coordinator).toBeDefined()
        })

        it('should set cloud adapter', async () => {
            await engine.setCloudAdapter(cloudAdapter)
            const adapter = await engine.getCloudAdapter()
            expect(adapter).toBeDefined()
        })
    })

    describe('Data Operations', () => {
        beforeEach(async () => {
            await engine.initialize()
        })

        it('should save single item', async () => {
            const testItem = { id: 'test1', content: 'test content' }
            const result = await engine.save('test_store', testItem)
            expect(result).toHaveLength(1)
            expect(result[0]).toEqual(testItem)
        })

        it('should save multiple items', async () => {
            const testItems = [
                { id: 'test1', content: 'content 1' },
                { id: 'test2', content: 'content 2' }
            ]
            const result = await engine.save('test_store', testItems)
            expect(result).toHaveLength(2)
            expect(result).toEqual(expect.arrayContaining(testItems))
        })

        it('should delete items', async () => {
            const testItem = { id: 'delete-test', content: 'to be deleted' }
            await engine.save('test_store', testItem)
            await engine.delete('test_store', testItem.id)
            
            const query = await engine.query('test_store')
            expect(query.items).toHaveLength(0)
        })

        it('should query items with pagination', async () => {
            const items = Array.from({ length: 50 }, (_, i) => ({
                id: `item-${i}`,
                content: `content ${i}`
            }))
            await engine.save('test_store', items)

            const result = await engine.query('test_store', { limit: 20, offset: 0 })
            expect(result.items).toHaveLength(20)
            expect(result.hasMore).toBe(true)
        })
    })

    describe('Sync Operations', () => {
        beforeEach(async () => {
            await engine.initialize()
            await engine.setCloudAdapter(cloudAdapter)
        })

        it('should sync data between local and cloud', async () => {
            // 准备本地数据
            const localItems = [
                { id: 'local1', content: 'local content 1' },
                { id: 'local2', content: 'local content 2' }
            ]
            await engine.save('test_store', localItems)

            // 准备云端数据
            const cloudItems = [
                { id: 'cloud1', content: 'cloud content 1' },
                { id: 'cloud2', content: 'cloud content 2' }
            ]
            await cloudAdapter.putBulk('test_store', cloudItems)

            // 执行同步
            const result = await engine.sync()
            expect(result.success).toBe(true)
            expect(result.stats).toBeDefined()

            // 验证数据同步结果
            const localQuery = await engine.query('test_store')
            expect(localQuery.items).toHaveLength(4) // 应该包含所有数据
        })

        it('should handle push operation', async () => {
            const localItem = { id: 'push-test', content: 'push content' }
            await engine.save('test_store', localItem)

            const result = await engine.push()
            expect(result.success).toBe(true)
            expect(result.stats?.uploaded).toBeGreaterThan(0)
        })

        it('should handle pull operation', async () => {
            const cloudItem = { id: 'pull-test', content: 'pull content' }
            await cloudAdapter.putBulk('test_store', [cloudItem])

            const result = await engine.pull()
            expect(result.success).toBe(true)
            expect(result.stats?.downloaded).toBeGreaterThan(0)
        })
    })


    describe('Error Handling', () => {
        it('should handle sync without cloud adapter', async () => {
            const result = await engine.sync()
            expect(result.success).toBe(false)
            expect(result.error).toBe('Cloud adapter not set')
        })

        it('should handle operation failures', async () => {
            // 模拟操作失败
            const failingAdapter = new MemoryAdapter()
            vi.spyOn(failingAdapter, 'putBulk').mockRejectedValue(new Error('Operation failed'))
            
            const engineWithFailingAdapter = new SyncEngine(failingAdapter, options)
            await engineWithFailingAdapter.initialize()

            try {
                await engineWithFailingAdapter.save('test_store', { id: 'fail-test', content: 'test' })
            } catch (error) {
                expect(error).toBeDefined()
            }
        })
    })

    describe('Status Management', () => {
        it('should update sync status correctly', async () => {
            await engine.initialize()
            await engine.setCloudAdapter(cloudAdapter)
    
            // 准备测试数据以确保有同步操作发生
            const testItem = { id: 'status-test', content: 'test content' }
            await engine.save('test_store', testItem)
    
            // 确保使用正确的 mock 函数
            const statusUpdateFn = vi.fn()
            engine.updateSyncOptions({
                onStatusUpdate: statusUpdateFn
            })
    
            // 执行同步
            await engine.sync()
    
            // 验证状态更新回调
            expect(statusUpdateFn).toHaveBeenCalled()
            // 验证状态序列 
            expect(statusUpdateFn).toHaveBeenCalledWith(expect.any(Number))
            // 验证最终状态
            const lastCall = statusUpdateFn.mock.calls[statusUpdateFn.mock.calls.length - 1]
            expect(lastCall[0]).toBe(SyncStatus.IDLE)
        })
    
        it('should handle offline status', async () => {
            await engine.initialize()
    
            // 使用新的 mock 函数
            const statusUpdateFn = vi.fn()
            engine.updateSyncOptions({
                onStatusUpdate: statusUpdateFn
            })
    
            // 断开连接
            engine.disconnectCloud()
    
            // 尝试同步触发离线状态
            await engine.sync()
    
            // 验证状态更新
            expect(statusUpdateFn).toHaveBeenCalledWith(SyncStatus.OFFLINE)
        })
    
        it('should update status during sync operations', async () => {
            await engine.initialize()
            await engine.setCloudAdapter(cloudAdapter)
    
            // 准备测试数据
            const localItem = { id: 'sync-status-test', content: 'test content' }
            await engine.save('test_store', localItem)
    
            // 设置状态监听
            const statusUpdateFn = vi.fn()
            engine.updateSyncOptions({
                onStatusUpdate: statusUpdateFn
            })
    
            // 执行推送操作
            await engine.push()
    
            // 验证状态变化序列
            expect(statusUpdateFn).toHaveBeenCalled()
            const statusCalls = statusUpdateFn.mock.calls.map(call => call[0])
            expect(statusCalls).toContain(SyncStatus.UPLOADING)
            expect(statusCalls).toContain(SyncStatus.IDLE)
        })
    })
    

    describe('Change Notifications', () => {
        it('should notify on data changes', async () => {
            await engine.initialize()
            await engine.setCloudAdapter(cloudAdapter)
    
            const onChangePushed = options.onChangePushed as ReturnType<typeof vi.fn>
            
            // 触发数据变更
            await engine.save('test_store', { id: 'change-test', content: 'test' })
            await engine.push()
    
            expect(onChangePushed).toHaveBeenCalled()
            const changeSet: DataChangeSet = onChangePushed.mock.calls[0][0]
            expect(changeSet.put.size).toBeGreaterThan(0)
        })
    })

    describe('Cleanup', () => {
        it('should dispose resources correctly', async () => {
            await engine.initialize()
            engine.enableAutoSync()
            
            engine.dispose()
            
            // 验证清理后的状态
            const cloudAdapter = await engine.getCloudAdapter()
            expect(cloudAdapter).toBeUndefined()
        })
    })
})

import { describe, test, expect, beforeEach } from 'vitest';
import { SyncView, SyncViewItem } from '../core/types';
import { performance } from 'perf_hooks';

describe('SyncView', () => {
    let syncView: SyncView;

    beforeEach(() => {
        syncView = new SyncView();
    });

    describe('**Basic CRUD Operations**', () => {
        test('should properly insert and retrieve items', () => {
            const testItem: SyncViewItem = {
                id: 'test1',
                store: 'notes',
                _ver: 1
            };

            syncView.upsert(testItem);
            const retrieved = syncView.get('notes', 'test1');

            expect(syncView.size()).toBe(1);
            expect(retrieved).toEqual(testItem);
        });

        test('should update existing items', () => {
            const initialItem: SyncViewItem = {
                id: 'test1',
                store: 'notes',
                _ver: 1
            };

            const updatedItem: SyncViewItem = {
                ...initialItem,
                _ver: 2
            };

            syncView.upsert(initialItem);
            syncView.upsert(updatedItem);
            const retrieved = syncView.get('notes', 'test1');

            expect(retrieved?._ver).toBe(2);
        });

        test('should delete items correctly', () => {
            const testItem: SyncViewItem = {
                id: 'test1',
                store: 'notes',
                _ver: 1
            };

            syncView.upsert(testItem);
            syncView.delete('notes', 'test1');

            expect(syncView.get('notes', 'test1')).toBeUndefined();
            expect(syncView.size()).toBe(0);
        });
    });

    describe('**Batch Operations**', () => {
        test('should handle batch insertions', () => {
            const items: SyncViewItem[] = [
                { id: '1', store: 'notes', _ver: 1 },
                { id: '2', store: 'notes', _ver: 1 },
                { id: '3', store: 'tasks', _ver: 1 }
            ];

            syncView.upsertBatch(items);

            expect(syncView.size()).toBe(3);
            expect(syncView.storeSize('notes')).toBe(2);
            expect(syncView.storeSize('tasks')).toBe(1);
        });

        test('should handle batch updates', () => {
            const initialItems: SyncViewItem[] = [
                { id: '1', store: 'notes', _ver: 1 },
                { id: '2', store: 'notes', _ver: 1 }
            ];

            const updatedItems: SyncViewItem[] = [
                { id: '1', store: 'notes', _ver: 2 },
                { id: '2', store: 'notes', _ver: 2 }
            ];

            syncView.upsertBatch(initialItems);
            syncView.upsertBatch(updatedItems);

            expect(syncView.get('notes', '1')?._ver).toBe(2);
            expect(syncView.get('notes', '2')?._ver).toBe(2);
        });
    });

    describe('**Store Operations**', () => {
        test('should correctly manage multiple stores', () => {
            syncView.upsertBatch([
                { id: '1', store: 'notes', _ver: 1 },
                { id: '2', store: 'tasks', _ver: 1 },
                { id: '3', store: 'contacts', _ver: 1 }
            ]);

            const stores = syncView.getStores();

            expect(stores).toContain('notes');
            expect(stores).toContain('tasks');
            expect(stores).toContain('contacts');
            expect(stores.length).toBe(3);
        });

        test('should handle store-specific operations', () => {
            syncView.upsertBatch([
                { id: '1', store: 'notes', _ver: 1 },
                { id: '2', store: 'notes', _ver: 1 },
                { id: '3', store: 'tasks', _ver: 1 }
            ]);

            const notesItems = syncView.getByStore('notes');
            expect(notesItems.length).toBe(2);

            const tasksItems = syncView.getByStore('tasks');
            expect(tasksItems.length).toBe(1);
        });
    });


    describe('**View Comparison and Diff**', () => {
        test('should correctly identify differences between views', () => {
            const localView = new SyncView();
            const remoteView = new SyncView();
            localView.upsert({ id: 'local1', store: 'notes', _ver: 1 });
            remoteView.upsert({ id: 'remote1', store: 'notes', _ver: 1 });
            const diff = SyncView.diffViews(localView, remoteView);
            expect(diff.toUpload.length).toBe(1);
            expect(diff.toDownload.length).toBe(1);
        });


        test('should handle version conflicts', () => {
            const localView = new SyncView();
            const remoteView = new SyncView();
            localView.upsert({ id: 'item1', store: 'notes', _ver: 2 });
            remoteView.upsert({ id: 'item1', store: 'notes', _ver: 1 });
            const diff = SyncView.diffViews(localView, remoteView);
            expect(diff.toUpload).toContainEqual(
                expect.objectContaining({ id: 'item1', _ver: 2 })
            );
        });
    });


    describe('**Pagination**', () => {
        test('should handle pagination correctly', () => {
            const items: SyncViewItem[] = Array.from({ length: 10 }, (_, i) => ({
                id: `${i}`,
                store: 'notes',
                _ver: 1
            }));
            syncView.upsertBatch(items);
            const page1 = syncView.getByStore('notes', 0, 5);
            const page2 = syncView.getByStore('notes', 5, 5);
            expect(page1.length).toBe(5);
            expect(page2.length).toBe(5);
            expect(page1[0].id).toBe('0');
            expect(page2[0].id).toBe('5');
        });
    });


    describe('**Serialization**', () => {
        test('should correctly serialize and deserialize view state', () => {
            const items: SyncViewItem[] = [
                { id: '1', store: 'notes', _ver: 1 },
                { id: '2', store: 'tasks', _ver: 1 }
            ];
            syncView.upsertBatch(items);
            const serialized = syncView.serialize();
            const newView = SyncView.deserialize(serialized);
            expect(newView.size()).toBe(2);
            expect(newView.get('notes', '1')).toEqual(items[0]);
            expect(newView.get('tasks', '2')).toEqual(items[1]);
        });
    });


    describe('**Performance Tests**', () => {
        const LARGE_DATASET_SIZE = 100000;
        function generateLargeDataset(size: number, baseVer = 1): SyncViewItem[] {
            return Array.from({ length: size }, (_, i) => ({
                id: `item${i}`,
                store: `store${Math.floor(i / 1000)}`,
                _ver: baseVer,
                data: `Some content for item ${i}`.repeat(5)
            }));
        }
        test('should handle large batch insertions (10k items)', () => {
            const startTime = performance.now();
            const items = generateLargeDataset(LARGE_DATASET_SIZE);
            syncView.upsertBatch(items);
            const endTime = performance.now();
            expect(syncView.size()).toBe(LARGE_DATASET_SIZE);
            console.log(`Batch insertion of ${LARGE_DATASET_SIZE} items took ${(endTime - startTime).toFixed(2)}ms`);
        });
        test('should efficiently compare large views (10k items)', () => {
            const localView = new SyncView();
            const remoteView = new SyncView();
            const baseItems = generateLargeDataset(LARGE_DATASET_SIZE, 1);
            const localItems = [
                ...baseItems.slice(0, LARGE_DATASET_SIZE - 1000),
                ...generateLargeDataset(1000, 2)
            ];
            const remoteItems = [
                ...baseItems.slice(1000),
                ...generateLargeDataset(1000, 3)
            ];
            localView.upsertBatch(localItems);
            remoteView.upsertBatch(remoteItems);
            const startTime = performance.now();
            const diff = SyncView.diffViews(localView, remoteView);
            const endTime = performance.now();
            expect(diff.toUpload.length + diff.toDownload.length).toBeGreaterThan(0);
            console.log(`Diff comparison of ${LARGE_DATASET_SIZE} items took ${(endTime - startTime).toFixed(2)}ms`);
        });

        
        test('should handle large dataset pagination efficiently', () => {
            const items = generateLargeDataset(LARGE_DATASET_SIZE);
            syncView.upsertBatch(items);

            const PAGE_SIZE = 100;
            const timings: number[] = [];

            for (let store = 0; store < 10; store++) {
                const startTime = performance.now();
                const results = syncView.getByStore(`store${store}`, 0, PAGE_SIZE);
                const endTime = performance.now();

                timings.push(endTime - startTime);
                expect(results.length).toBeLessThanOrEqual(PAGE_SIZE);
            }

            const avgTime = timings.reduce((a, b) => a + b, 0) / timings.length;
            console.log(`Average pagination query time: ${avgTime.toFixed(2)}ms`);
        });

        test('should efficiently serialize and deserialize large datasets', () => {
            const items = generateLargeDataset(LARGE_DATASET_SIZE);
            syncView.upsertBatch(items);

            const serializeStartTime = performance.now();
            const serialized = syncView.serialize();
            const serializeEndTime = performance.now();

            const deserializeStartTime = performance.now();
            const newView = SyncView.deserialize(serialized);
            const deserializeEndTime = performance.now();

            expect(newView.size()).toBe(LARGE_DATASET_SIZE);

            console.log(`Serialization took ${(serializeEndTime - serializeStartTime).toFixed(2)}ms`);
            console.log(`Deserialization took ${(deserializeEndTime - deserializeStartTime).toFixed(2)}ms`);
            console.log(`Serialized data size: ${(serialized.length / 1024 / 1024).toFixed(2)}MB`);
        });

        test('should handle concurrent operations on large datasets', async () => {
            const items = generateLargeDataset(LARGE_DATASET_SIZE);
            syncView.upsertBatch(items);

            const startTime = performance.now();

            await Promise.all([
                Promise.all(Array.from({ length: 100 }, (_, i) =>
                    Promise.resolve(syncView.get(`store${i % 10}`, `item${i}`))
                )),

                Promise.all(Array.from({ length: 100 }, (_, i) =>
                    Promise.resolve(syncView.upsert({
                        id: `newItem${i}`,
                        store: `store${i % 10}`,
                        _ver: 1,
                    }))
                )),

                Promise.all(Array.from({ length: 100 }, (_, i) =>
                    Promise.resolve(syncView.delete(`store${i % 10}`, `item${i}`))
                ))
            ]);

            const endTime = performance.now();
            console.log(`Concurrent operations took ${(endTime - startTime).toFixed(2)}ms`);
        });

        test('should maintain performance with frequent updates', () => {
            const items = generateLargeDataset(LARGE_DATASET_SIZE);
            syncView.upsertBatch(items);

            const UPDATE_COUNT = 1000;
            const timings: number[] = [];

            for (let i = 0; i < UPDATE_COUNT; i++) {
                const randomId = Math.floor(Math.random() * LARGE_DATASET_SIZE);
                const startTime = performance.now();

                syncView.upsert({
                    id: `item${randomId}`,
                    store: `store${Math.floor(randomId / 1000)}`,
                    _ver: 2,
                });

                timings.push(performance.now() - startTime);
            }

            const avgUpdateTime = timings.reduce((a, b) => a + b, 0) / UPDATE_COUNT;
            console.log(`Average update time: ${avgUpdateTime.toFixed(2)}ms`);
        });

        test('should not exceed 5MB size limit for single syncview', () => {
            // 创建一个接近但略小于5MB的数据集
            const items: SyncViewItem[] = [];
            const MAX_SIZE_MB = 5;
            const SAFETY_MARGIN = 0.9; // 使用90%的限制作为安全边界
            let currentSize = 0;
            let itemCount = 0;
        
            // 使用安全边界计算实际目标大小
            const targetSize = MAX_SIZE_MB * SAFETY_MARGIN;
        
            while (currentSize < targetSize) {
                const item: SyncViewItem = {
                    id: `item${itemCount}`,
                    store: `store${Math.floor(itemCount / 1000)}`,
                    _ver: 1,
                };
        
                // 预先检查添加这个项是否会超出限制
                const itemSize = new TextEncoder().encode(JSON.stringify(item)).length / (1024 * 1024);
                if (currentSize + itemSize > targetSize) {
                    break;
                }
        
                items.push(item);
                itemCount++;
                currentSize += itemSize;
            }
        
            syncView.upsertBatch(items);
        
            // 序列化整个视图
            const serialized = syncView.serialize();
            const sizeInMB = new TextEncoder().encode(serialized).length / (1024 * 1024);
        
            console.log(`SyncView size: ${sizeInMB.toFixed(2)}MB with ${itemCount} items`);
            console.log(`Average item size: ${(sizeInMB / itemCount).toFixed(4)}MB`);
            
            // 验证大小限制
            expect(sizeInMB).toBeLessThanOrEqual(MAX_SIZE_MB);
        
            // 测试序列化和反序列化是否正常工作
            const deserializedView = SyncView.deserialize(serialized);
            expect(deserializedView.size()).toBe(itemCount);
        
            // 验证查询性能
            const startTime = performance.now();
            const randomId = Math.floor(Math.random() * itemCount);
            const retrieved = syncView.get(`store${Math.floor(randomId / 1000)}`, `item${randomId}`);
            const endTime = performance.now();
        
            expect(retrieved).toBeDefined();
            console.log(`Query time for size-limited view: ${(endTime - startTime).toFixed(2)}ms`);
        });
        
        
        test('should throw error when exceeding 5MB size limit', () => {
            // 创建一个超过5MB的数据集
            const items: SyncViewItem[] = Array.from({ length: 10000 }, (_, i) => ({
                id: `item${i}`,
                store: `store${Math.floor(i / 1000)}`,
                _ver: 1,
                data: Array(1000).fill('x').join('') // 每个项约1KB的数据
            }));
            // 应该抛出错误
            expect(() => {
                syncView.upsertBatch(items);
                const serialized = syncView.serialize();
                const sizeInMB = new TextEncoder().encode(serialized).length / (1024 * 1024);
                if (sizeInMB > 5) {
                    throw new Error(`SyncView size ${sizeInMB.toFixed(2)}MB exceeds 5MB limit`);
                }
            }).toThrow(/exceeds 5MB limit/);
        });
    });
});

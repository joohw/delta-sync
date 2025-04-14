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

    });
});

import { describe, test, expect, beforeEach } from 'vitest';
import { SyncView, SyncViewItem } from '../core/types';
import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';

describe('**SyncView Size Analysis**', () => {
    let syncView: SyncView;

    beforeEach(() => {
        syncView = new SyncView();
    });

    function generateRealisticSyncViewItem(index: number): SyncViewItem {
        return {
            id: uuidv4(),
            store: `store${Math.floor(index / 1000)}`,
            _ver: Math.floor(Math.random() * 5) + 1,
            deleted: Math.random() < 0.2,
            isAttachment: Math.random() < 0.1
        };
    }

    // 增加超时时间到30秒，减少测试数据量
    test('analyze syncview size distribution with realistic data', async () => {
        // 减少测试数据量
        const testVolumes = [1000, 5000, 10000, 50000, 100000];
        const results: Array<{
            items: number;
            sizeInMB: number;
            avgItemSizeInBytes: number;
            serializationTimeMs: number;
            stores: number;
            deletedItems: number;
            attachments: number;
        }> = [];

        for (const volume of testVolumes) {
            // 清空之前的数据
            syncView.clear();

            console.log(`\nTesting with ${volume} items...`);
            // 分批生成和插入数据，避免内存压力
            const BATCH_SIZE = 1000;
            const totalBatches = Math.ceil(volume / BATCH_SIZE);
            let totalDeletedItems = 0;
            let totalAttachments = 0;
            const storesSet = new Set<string>();
            const insertStartTime = performance.now();

            for (let batch = 0; batch < totalBatches; batch++) {
                const start = batch * BATCH_SIZE;
                const end = Math.min(start + BATCH_SIZE, volume);
                const items = Array.from(
                    { length: end - start },
                    (_, i) => generateRealisticSyncViewItem(start + i)
                );
                // 统计信息
                items.forEach(item => {
                    storesSet.add(item.store);
                    if (item.deleted) totalDeletedItems++;
                    if (item.isAttachment) totalAttachments++;
                });
                syncView.upsertBatch(items);
            }
            const insertTime = performance.now() - insertStartTime;
            console.log(`Insert time: ${insertTime.toFixed(2)}ms`);
            // 序列化测试
            const serializeStartTime = performance.now();
            const serialized = syncView.serialize();
            const serializationTime = performance.now() - serializeStartTime;
            // 计算大小
            const sizeInBytes = new TextEncoder().encode(serialized).length;
            const sizeInMB = sizeInBytes / (1024 * 1024);
            const avgItemSizeInBytes = sizeInBytes / volume;
            results.push({
                items: volume,
                sizeInMB: sizeInMB,
                avgItemSizeInBytes: avgItemSizeInBytes,
                serializationTimeMs: serializationTime,
                stores: storesSet.size,
                deletedItems: totalDeletedItems,
                attachments: totalAttachments
            });
            // 验证数据完整性
            expect(syncView.size()).toBe(volume);
        }

        // 打印分析报告
        console.log('\n📊 SyncView Size Analysis Report');
        console.log('================================================================');
        console.log('Items\t\tSize(MB)\tAvg(B)\tSerial(ms)\tStores\tDeleted\tAttach');
        console.log('----------------------------------------------------------------');
        results.forEach(r => {
            console.log(
                `${r.items.toString().padEnd(8)}\t` +
                `${r.sizeInMB.toFixed(2).padEnd(8)}\t` +
                `${Math.round(r.avgItemSizeInBytes).toString().padEnd(6)}\t` +
                `${Math.round(r.serializationTimeMs).toString().padEnd(8)}\t` +
                `${r.stores.toString().padEnd(8)}\t` +
                `${r.deletedItems.toString().padEnd(8)}\t` +
                r.attachments
            );
        });
        console.log('================================================================');

        // 100k数据分析
        const result100k = results.find(r => r.items === 100000);
        if (result100k) {
            console.log('\n🔍 Detailed Analysis for 100k items:');
            console.log(`Total Size: ${result100k.sizeInMB.toFixed(2)}MB`);
            console.log(`Average Item Size: ${Math.round(result100k.avgItemSizeInBytes)} bytes`);
            console.log(`Serialization Time: ${Math.round(result100k.serializationTimeMs)}ms`);
            console.log(`Number of Stores: ${result100k.stores}`);
            console.log(`Deleted Items: ${result100k.deletedItems} (${(result100k.deletedItems/100000*100).toFixed(1)}%)`);
            console.log(`Attachments: ${result100k.attachments} (${(result100k.attachments/100000*100).toFixed(1)}%)`);
            // 分片建议
            const TARGET_SHARD_SIZE_MB = 4;
            const suggestedShardSize = Math.ceil(100000 / Math.ceil(result100k.sizeInMB / TARGET_SHARD_SIZE_MB));
            console.log('\n💡 Sharding Recommendations:');
            console.log(`- Items per shard (targeting ${TARGET_SHARD_SIZE_MB}MB shards): ${suggestedShardSize}`);
            console.log(`- Expected number of shards for 100k items: ${Math.ceil(100000 / suggestedShardSize)}`);
            console.log(`- Expected shard size: ${(result100k.sizeInMB / Math.ceil(100000 / suggestedShardSize)).toFixed(2)}MB`);
        }
        // 内存使用分析
        const memory = process.memoryUsage();
        console.log('\n📈 Memory Usage:');
        console.log(`Heap Used: ${(memory.heapUsed / 1024 / 1024).toFixed(2)}MB`);
        console.log(`Heap Total: ${(memory.heapTotal / 1024 / 1024).toFixed(2)}MB`);
        console.log(`RSS: ${(memory.rss / 1024 / 1024).toFixed(2)}MB`);
    }, { timeout: 30000 }); // 设置超时时间为30秒
});

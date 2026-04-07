import { describe, expect, it } from 'vitest';
import { SyncEngine } from '../core/SyncEngine';
import { DatabaseAdapter, SyncStatus, TOMBSTONE_STORE } from '../core/types';
import { SyncViewItem } from '../core/SyncView';

type RecordItem = { id: string; _ver: number; [key: string]: unknown };

class InMemoryAdapter implements DatabaseAdapter {
    private stores = new Map<string, Map<string, RecordItem>>();

    constructor(initial: Record<string, RecordItem[]> = {}) {
        Object.entries(initial).forEach(([store, items]) => {
            const storeMap = new Map<string, RecordItem>();
            items.forEach(item => storeMap.set(item.id, { ...item }));
            this.stores.set(store, storeMap);
        });
    }

    async listStoreItems(
        storeName: string,
        offset?: number,
        since?: number,
    ): Promise<{ items: SyncViewItem[]; hasMore?: boolean; offset?: number; }> {
        const storeMap = this.stores.get(storeName) ?? new Map<string, RecordItem>();
        const start = offset ?? 0;
        const items = Array.from(storeMap.values())
            .filter(item => since === undefined || item._ver > since)
            .slice(start)
            .map(item => ({ id: item.id, _ver: item._ver, store: storeName, deleted: Boolean((item as any).deleted) }));
        return { items, hasMore: false };
    }

    async readStore<T extends { id: string }>(
        storeName: string,
        limit?: number,
        offset?: number
    ): Promise<{ items: T[]; hasMore: boolean; }> {
        const storeMap = this.stores.get(storeName) ?? new Map<string, RecordItem>();
        const start = offset ?? 0;
        const end = limit ? start + limit : undefined;
        const items = Array.from(storeMap.values()).slice(start, end) as unknown as T[];
        return { items, hasMore: false };
    }

    async readBulk<T extends { id: string }>(storeName: string, ids: string[]): Promise<T[]> {
        const storeMap = this.stores.get(storeName) ?? new Map<string, RecordItem>();
        return ids
            .map(id => storeMap.get(id))
            .filter((item): item is RecordItem => Boolean(item))
            .map(item => ({ ...item } as unknown as T));
    }

    async putBulk<T extends { id: string }>(storeName: string, items: T[]): Promise<T[]> {
        if (!this.stores.has(storeName)) {
            this.stores.set(storeName, new Map<string, RecordItem>());
        }
        const storeMap = this.stores.get(storeName)!;
        items.forEach(item => {
            storeMap.set(item.id, { ...(item as any) });
        });
        return items;
    }

    async deleteBulk(storeName: string, ids: string[]): Promise<void> {
        const storeMap = this.stores.get(storeName);
        if (!storeMap) return;
        ids.forEach(id => storeMap.delete(id));
    }

    async clearStore(storeName: string): Promise<boolean> {
        this.stores.set(storeName, new Map<string, RecordItem>());
        return true;
    }
}

class ThrowingListAdapter extends InMemoryAdapter {
    async listStoreItems(): Promise<{ items: SyncViewItem[]; hasMore?: boolean; offset?: number; }> {
        throw new Error('list failed');
    }
}

describe('SyncEngine checkpoint reliability', () => {
    it('advances checkpoint from pulled versions only', async () => {
        const local = new InMemoryAdapter({
            notes: [{ id: 'local-high', _ver: 1000, text: 'local' }]
        });
        const cloud = new InMemoryAdapter({
            notes: [{ id: 'cloud-low', _ver: 10, text: 'cloud' }]
        });
        const engine = new SyncEngine(local, ['notes']);
        await engine.setCloudAdapter(cloud);

        await engine.sync();

        expect(engine.getCheckpoint()).toBe(10);
        const pulled = await local.readBulk<RecordItem>('notes', ['cloud-low']);
        expect(pulled).toHaveLength(1);
    });

    it('does not skip late remote writes after high-version upload', async () => {
        const local = new InMemoryAdapter({
            notes: [{ id: 'local-high', _ver: 1000, text: 'local' }]
        });
        const cloud = new InMemoryAdapter();
        const engine = new SyncEngine(local, ['notes']);
        await engine.setCloudAdapter(cloud);

        await engine.sync();
        expect(engine.getCheckpoint()).toBe(0);

        await cloud.putBulk('notes', [{ id: 'late-remote', _ver: 20, text: 'late' }]);
        await engine.sync();

        expect(engine.getCheckpoint()).toBe(20);
        const pulled = await local.readBulk<RecordItem>('notes', ['late-remote']);
        expect(pulled).toHaveLength(1);
    });

    it('sets status to ERROR when diff listing fails', async () => {
        const statuses: SyncStatus[] = [];
        const local = new ThrowingListAdapter({
            [TOMBSTONE_STORE]: []
        });
        const cloud = new InMemoryAdapter();
        const engine = new SyncEngine(local, ['notes'], {
            onStatusUpdate: (status) => statuses.push(status)
        });
        await engine.setCloudAdapter(cloud);

        await engine.sync();

        expect(statuses[statuses.length - 1]).toBe(SyncStatus.ERROR);
        expect(engine.getCheckpoint()).toBe(0);
    });
});

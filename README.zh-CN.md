# DeltaSync

[![npm version](https://img.shields.io/npm/v/delta-sync.svg)](https://www.npmjs.com/package/delta-sync)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

**一个轻量级跨平台数据同步引擎**

DeltaSync 是一个专门为现代应用设计的数据同步框架，它能帮助开发者轻松实现数据的双向同步、离线存储和冲突处理。无论是 Web 应用、移动应用还是桌面应用，DeltaSync 都能提供一致的同步体验。

## 核心特性

- **轻量灵活**: 核心代码不到2000行，依赖极少
- **适配器模式**: 轻松对接任意数据库系统
- **版本控制**: 自动跟踪数据变更，使用基于时间戳的版本号
- **增量同步**: 通过检查点机制仅同步变更数据，大幅提升性能
- **离线支持**: 完整的离线工作能力，网络恢复后自动同步
- **类型安全**: 使用 TypeScript 编写，提供完整类型定义
- **批量处理**: 支持批量数据同步
- **完整事件**: 提供丰富的同步事件回调
- **墓碑机制**: 完善的删除追踪机制，支持保留策略

## 安装

```bash
npm install delta-sync
```

## 快速开始

1. 创建数据库适配器:

```typescript
import { DatabaseAdapter } from 'delta-sync';

class MyDatabaseAdapter implements DatabaseAdapter {
  async readStore<T extends { id: string }>(
    storeName: string,
    limit?: number,
    offset?: number
  ): Promise<{ items: T[]; hasMore: boolean }> {
    // 实现数据读取逻辑
  }

  async listStoreItems(
    storeName: string,
    offset?: number,
    since?: number,
    before?: number
  ): Promise<{
    items: Array<{ id: string; _ver: number; store?: string; deleted?: boolean }>;
    hasMore?: boolean;
    offset?: number;
  }> {
    // 实现列表项逻辑（用于同步视图）
  }

  async readBulk<T extends { id: string }>(
    storeName: string,
    ids: string[]
  ): Promise<T[]> {
    // 实现批量读取逻辑
  }

  async putBulk<T extends { id: string }>(
    storeName: string,
    items: T[]
  ): Promise<T[]> {
    // 实现批量写入逻辑
  }

  async deleteBulk(storeName: string, ids: string[]): Promise<void> {
    // 实现批量删除逻辑
  }

  async clearStore(storeName: string): Promise<boolean> {
    // 实现清空存储逻辑
  }
}
```

2. 初始化同步引擎:

```typescript
import { SyncEngine } from 'delta-sync';

const localAdapter = new MyDatabaseAdapter();
const cloudAdapter = new MyCloudAdapter();

// 指定需要同步的存储
const storesToSync = ['notes', 'tasks', 'tombStones'];

const engine = new SyncEngine(localAdapter, storesToSync, {
  autoSync: {
    enabled: true,
    pullInterval: 60000, // 每60秒自动同步
    pushDebounce: 10000 // 本地更改10秒后推送
  },
  onStatusUpdate: (status) => {
    console.log('同步状态:', status);
  }
});

// 初始化引擎
await engine.initialize();

// 设置云端适配器
await engine.setCloudAdapter(cloudAdapter);
```

3. 数据操作:

```typescript
// 保存数据（单个或批量）
await engine.save('notes', {
  id: '1',
  title: '测试笔记',
  content: '内容...'
});

// 保存多个项目
await engine.save('notes', [
  { id: '1', title: '笔记1', content: '...' },
  { id: '2', title: '笔记2', content: '...' }
]);

// 删除数据
await engine.delete('notes', '1');
// 或删除多个
await engine.delete('notes', ['1', '2']);
```

## 同步原理

DeltaSync 采用基于版本的增量同步机制:

1. **版本追踪**: 每个数据项都有一个 `_ver` 字段（基于时间戳的版本号）

2. **变更追踪**: 使用 `SyncView` 存储所有数据的最新版本信息，用于快速比对

3. **同步模式**:
   - **同步 (`sync`)**: 本地与云端各列举元数据 **一次**，用 `getRoundTripDiff` **一次**算出上传与拉取两个 diff，再**先推后拉**；结束时更新 checkpoint
   - **增量**: `sync()` 默认用内部 `checkpoint` 作为 `since` 做 `listStoreItems`
   - **全量列举**: 在适配器约定下可对 `sync(stores, 0)` 使用 `since === 0`
   - **冲突处理**: 采用「最新版本胜出」策略（更高的 `_ver` 获胜）

4. **墓碑机制**: 
   - 已删除的项目会被追踪在特殊的 `tombStones` 存储中
   - 墓碑默认保留180天
   - 确保删除操作在所有设备间正确传播

5. **离线支持**: 
   - 离线时正常工作
   - 变更会被缓存，网络恢复后自动同步
   - 防止重复同步

## 高级功能

### 同步方法

```typescript
// 同步：每边元数据各扫一次 + getRoundTripDiff 一次，再先推后拉
await engine.sync();

// 可选：显式 store 与 since（例如适配器约定 since===0 表示全量列举）
// await engine.sync(['notes', 'decks'], 0);
```

### 自定义同步选项

```typescript
engine.updateSyncOptions({
  maxRetries: 3, // 最大重试次数
  timeout: 30000, // 超时时间(ms)
  batchSize: 100, // 批量同步大小
  maxFileSize: 10485760, // 最大文件大小(10MB)
  fileChunkSize: 1048576, // 文件分片大小(1MB)
  autoSync: {
    enabled: true,
    pullInterval: 60000, // 拉取间隔(ms)
    pushDebounce: 10000, // 推送防抖延迟(ms)
    retryDelay: 3000 // 重试延迟(ms)
  }
});
```

### 同步事件监听

```typescript
const options = {
  onStatusUpdate: (status: SyncStatus) => {
    console.log('同步状态:', status);
  },
  onSyncProgress: (progress: { processed: number; total: number }) => {
    console.log(`进度: ${progress.processed}/${progress.total}`);
  },
  onVersionUpdate: (version: number) => {
    console.log('最新版本已更新到:', version);
  },
  onChangePushed: (changes: DataChangeSet) => {
    console.log('推送变更:', changes);
  },
  onChangePulled: (changes: DataChangeSet) => {
    console.log('拉取变更:', changes);
  },
  onPullAvailableCheck: () => {
    // 返回 true 表示允许拉取
    return navigator.onLine;
  },
  onPushAvailableCheck: () => {
    // 返回 true 表示允许推送
    return navigator.onLine;
  }
};
```

### 存储管理

```typescript
// 清空本地存储
await engine.clearLocalStores('notes');
await engine.clearLocalStores(['notes', 'tasks']);

// 清空云端存储
await engine.clearCloudStores('notes');
await engine.clearCloudStores(['notes', 'tasks']);
```

### 自动同步控制

```typescript
// 启用自动同步
engine.enableAutoSync(60000); // 60秒间隔

// 禁用自动同步
engine.dispose(); // 同时清除定时器并重置状态
```

## 适配器开发

开发自定义适配器需实现 `DatabaseAdapter` 接口:

```typescript
export interface DatabaseAdapter {
  readStore<T extends { id: string }>(
    storeName: string,
    limit?: number,
    offset?: number
  ): Promise<{ items: T[]; hasMore: boolean }>;

  listStoreItems(
    storeName: string,
    offset?: number,
    since?: number,
    before?: number
  ): Promise<{
    items: SyncViewItem[];
    hasMore?: boolean;
    offset?: number;
  }>;

  readBulk<T extends { id: string }>(
    storeName: string,
    ids: string[]
  ): Promise<T[]>;

  putBulk<T extends { id: string }>(
    storeName: string,
    items: T[]
  ): Promise<T[]>;

  deleteBulk(storeName: string, ids: string[]): Promise<void>;

  clearStore(storeName: string): Promise<boolean>;
}
```

**重要提示:**
- `listStoreItems` 应按 `_ver` 降序返回项目，以便高效的基于检查点的增量同步
- `listStoreItems` 中的 `since` 参数用于增量同步（仅返回 `_ver > since` 的项目）
- `before` 参数可用于过滤旧的墓碑数据
- 项目必须包含 `id` 和 `_ver` 字段

## 技术架构

### 核心组件

1. **SyncEngine**: 主同步控制器
   - 管理同步生命周期
   - 协调本地和云端操作
   - 处理自动同步调度
   - 提供数据操作方法（save, delete）

2. **SyncView**: 用于快速比对的数据视图
   - 存储轻量级元数据（id、版本、存储、删除标志）
   - 支持高效的差异计算
   - 通过检查点支持增量同步

3. **DatabaseAdapter**: 数据库接口
   - 提供统一的数据访问
   - 抽象数据库操作
   - 确保跨平台兼容性

4. **检查点机制**: 
   - 跟踪每个存储的最新版本
   - 支持高效的增量同步
   - 减少大数据集的数据传输

### 同步状态

```typescript
export enum SyncStatus {
  REJECTED = -3,  // 推送被可用性检查拒绝
  ERROR = -2,     // 错误状态
  OFFLINE = -1,   // 离线状态
  IDLE = 0,       // 空闲状态
  UPLOADING = 1,  // 上传进行中
  DOWNLOADING = 2, // 下载进行中
  OPERATING = 3,  // 操作进行中（清空存储等）
  CHECKING = 4,   // 检查云端变更中
}
```

### 版本控制

- 每个数据项都有一个 `_ver`（版本）字段
- 版本号基于时间戳（自纪元以来的毫秒数）
- 支持冲突检测和解决（最新版本胜出）
- 版本在保存操作时自动分配

### 数据结构

所有数据项必须包含:
- `id: string` - 唯一标识符
- `_ver: number` - 版本号（时间戳）

示例:
```typescript
interface Note {
  id: string;
  _ver: number; // 由 SyncEngine 自动设置
  title: string;
  content: string;
  // ... 其他字段
}
```

## 性能考虑

- **批量处理**: 所有操作都使用批量处理以提高效率
- **增量同步**: 检查点机制显著减少数据传输
- **防抖机制**: 本地更改在推送前会进行防抖处理，减少网络调用
- **内存高效**: SyncView 使用轻量级元数据而非完整数据
- **懒加载**: 数据在同步操作期间按需加载

## 最佳实践

1. **存储命名**: 如果需要删除追踪，请始终在 `storesToSync` 数组中包含 `'tombStones'`
2. **初始化**: 使用引擎前始终调用 `engine.initialize()`
3. **错误处理**: 在适配器中实现适当的错误处理
4. **版本管理**: 永远不要手动修改 `_ver` 字段 - 让 SyncEngine 处理它
5. **清理**: 完成后调用 `engine.dispose()` 以清理定时器和资源

## 许可证

ISC

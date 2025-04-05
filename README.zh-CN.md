# DeltaSync[alpha]

一句话介绍：一个极致轻量的双向同步框架

DeltaSync 是一个专门为现代应用设计的数据同步框架，它能帮助开发者轻松实现数据的双向同步、离线存储和冲突处理。无论是 Web 应用、移动应用还是桌面应用，DeltaSync 都能提供一致的同步体验。




## 特性

- **轻量灵活**: 核心代码不到1500行,无复杂依赖
- **适配器模式**: 轻松对接任意数据库系统
- **版本管理**: 自动跟踪数据变更,确保同步一致性
- **增量同步**: 仅同步变更数据,提高性能
- **离线支持**: 完整的离线工作支持
- **类型安全**: 使用 TypeScript 编写,提供完整类型定义
- **自动重试**: 网络异常时自动重试
- **批量处理**: 支持批量数据同步
- **完整事件**: 提供丰富的同步事件回调

## 安装

```bash
npm install delta-sync
```



## 快速开始

1. 创建数据库适配器:
```
typescript
import { DatabaseAdapter } from 'delta-sync';

class MyDatabaseAdapter implements DatabaseAdapter {
// 实现必要的接口方法
async readStore<T>(storeName: string, limit?: number, offset?: number) {
// 实现数据读取逻辑
}

async putBulk<T>(storeName: string, items: T[]) {
// 实现批量写入逻辑
}

// ...其他接口实现
}
```
或者使用现成的适配器：


```
import { MemoryAdapter } from 'delta-sync';

```


2. 初始化同步引擎:
```typescript
import { SyncEngine } from 'delta-sync';

const localAdapter = new MyDatabaseAdapter();
const cloudAdapter = new MyCloudAdapter();

const engine = new SyncEngine(localAdapter, {
autoSync: {
enabled: true,
pullInterval: 30000, // 每30秒自动同步
pushDebounce: 5000 // 本地更改5秒后推送
},
onStatusUpdate: (status) => {
console.log('同步状态:', status);
}
});

// 设置云端适配器
await engine.setCloudAdapter(cloudAdapter);
```

3 数据操作:
```typescript
// 保存数据
await engine.save('notes', {
id: '1',
title: '测试笔记',
content: '内容...'
});

// 删除数据
await engine.delete('notes', '1');

// 查询数据
const result = await engine.query('notes', {
limit: 10,
offset: 0
});
```


## 同步原理

DeltaSync 采用基于版本的增量同步机制:

1. **本地更改**: 所有通过同步引擎的数据操作都会被自动记录版本信息

2. **变更追踪**: 使用 SyncView 存储所有数据的最新版本信息

3. **增量同步**: 
- Push: 将本地新版本数据推送到云端
- Pull: 拉取云端新版本数据到本地
- 冲突处理: 采用"最新版本胜出"策略

4. **离线支持**: 
- 离线时正常工作
- 网络恢复后自动同步
- 防止重复同步


## 高级功能

### 自定义同步选项


```
typescript
engine.updateSyncOptions({
maxRetries: 3, // 最大重试次数
timeout: 30000, // 超时时间(ms)
batchSize: 100, // 批量同步大小
maxFileSize: 10485760, // 最大文件大小(10MB)
fileChunkSize: 1048576 // 文件分片大小(1MB)
});
```

### 同步事件监听

```typescript
const options = {
onStatusUpdate: (status) => {
console.log('同步状态:', status);
},
onChangePushed: (changes) => {
console.log('推送变更:', changes);
},
onChangePulled: (changes) => {
console.log('拉取变更:', changes);
}
};
```


### 手动控制同步

```typescript
await engine.sync();

// 仅推送本地更改
await engine.push();

// 仅拉取远程更改
await engine.pull();
```

## 适配器开发

开发自定义适配器需实现 `DatabaseAdapter` 接口:

typescript
export interface DatabaseAdapter {
readStore<T>(...): Promise<SyncQueryResult<T>>;
readBulk<T>(...): Promise<T[]>;
putBulk<T>(...): Promise<T[]>;
deleteBulk(...): Promise<void>;
clearStore(...): Promise<boolean>;
getStores(): Promise<string[]>;
}


## 许可证

MIT
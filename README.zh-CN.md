# DeltaSync[alpha]

一句话介绍：一个极致轻量的双向同步框架

DeltaSync 专为需要轻量级、高效、可靠的数据同步解决方案的应用而设计，特别适合需要离线优先体验的场景。

其模块化设计和适配器模式使其能够轻松集成到各种应用架构中。



## 特性

- **极致轻量化**：简单整合到任何数据库系统
- **自动版本跟踪**：每条数据自动带有版本号，确保同步一致性
- **冲突解决**：基于时间戳的自动冲突解决策略
- **文件附件同步**：支持数据关联文件的同步
- **自定义同步策略**：可根据应用需求定制同步行为
- **批处理性能**：批量处理数据变更提高性能
- **事件驱动架构**：易于集成到各种应用框架中
- **离线优先支持**：完全支持离线操作和自动恢复同步
- **TypeScript友好**：完整的类型定义提供良好的开发体验
- **端到端加密支持**：保护敏感数据安全

## 同步机制

每个数据实体都有版本号 _version
版本号基于递增机制，确保变更顺序
统一采用"最后修改胜出"的冲突解决策略


## 离线支持
完全离线工作：所有操作在本地正常执行
变更队列：离线期间的变更排队等待同步
自动恢复：网络连接恢复后自动同步累积变更
冲突处理：解决离线期间可能发生的数据冲突

## 端到端加密支持

支持端到端加密：可配置敏感数据的加密
传输安全：依赖传输层安全协议

## 部署灵活性

DeltaSync 可以部署在多种环境：
Web 应用与 PWA
移动应用（React Native、Flutter）
桌面应用（Electron）
服务器端（Node.js）


## Installation

```bash
npm install delta-sync
```



## 冲突解决 (Conflict Resolution)

DeltaSync 默认采用"最后修改胜出"的策略解决冲突。
版本号包括文件版本号和整体版本号，文件版本号表示修改时的仓库版本号，仓库版本号是整体自增的。
当多个设备对同一数据进行修改时，系统会根据版本号决定以哪个版本为准。



## 实现原理
DeltaSync 通过 DataAdapter 接口实现数据库无关的同步机制，支持多种存储解决方案。
只需要实现这里的存储适配器，就可以无缝集成到任何应用中。


## 适配器测试工具

DeltaSync 提供了全面的适配器测试工具，帮助开发者验证自定义数据库适配器的实现是否符合规范。
这些工具可以轻松检测适配器的功能完整性、正确性和性能表现。

```typescript
import { testAdapterFunctionality, testAdapterPerformance } from 'delta-sync/test';
import { MyDatabaseAdapter } from './my-adapter';

// 创建适配器实例
const adapter = new MyDatabaseAdapter();
// 功能测试
const functionalResults = await testAdapterFunctionality(adapter);
console.log('功能测试通过:', functionalResults.success);
// 性能测试
const performanceResults = await testAdapterPerformance(adapter, {
  itemCount: 200,    // 测试数据量
  iterations: 3,     // 重复测试次数
  fileSize: 512 * 1024 // 测试文件大小
});
```

## 核心架构

适配器层 (Adapter Layer)

DataAdapter 接口：定义了一套通用的数据操作接口，包括读取、写入、删除等基本操作
专用适配器：为各种数据库系统提供具体实现，如 IndexedDB、SQLite、REST API 等
无缝转换：将各种数据库的特定 API 转换为统一的接口，屏蔽底层差异

同步协调层 (Sync Coordination)

SyncCoordinator：客户端协调器，负责跟踪本地数据变更
CloudCoordinator：服务端协调器，处理来自多个客户端的同步请求
自动变更记录：任何通过协调层的数据操作都会自动记录变更信息


数据版本跟踪 (Version Tracking)

版本号机制：每条数据都附带版本号(_version)，基于时间戳自动更新




### 同步流程 (Sync Process)

变更跟踪：本地操作通过协调层自动记录到 _sync_changes 表
变更推送：客户端将本地变更推送到服务器
冲突检测：服务器检测并解决可能的冲突
变更应用：服务器应用变更并记录到变更历史
变更拉取：客户端拉取服务器上的新变更
本地应用：客户端应用远程变更到本地数据库


### 离线支持 (Offline Support)

完全离线工作：应用可以在离线状态下正常工作，所有操作都在本地记录
自动同步恢复：网络连接恢复后，自动同步积累的变更
并发控制：防止多次同步请求同时执行导致的问题
该架构设计使 DeltaSync 能够在保持轻量级的同时，提供强大的跨数据库同步能力，适用于各种需要离线优先、实时数据同步的应用场景。
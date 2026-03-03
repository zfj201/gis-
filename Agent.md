# Agent.md - 文旅智慧助手（空间检索子系统）实现总纲

## 1. 项目定位与范围

### 1.1 定位
- 本项目是“文旅智慧助手”的空间检索子系统，负责把自然语言转成可执行 GIS 查询，并返回地图可视化结果与自然语言总结。

### 1.2 本期范围
- 多 FeatureLayer 注册与管理。
- 自然语言到 DSL 的语义解析（模型优先，规则兜底）。
- ArcGIS REST 查询执行与地图高亮（点/线/面）。
- 缓冲区查询（点中心与跨图层线/面源要素缓冲）。

### 1.3 非目标
- 不做编辑写回、权限体系、复杂拓扑建模。
- 不做多目标图层并行聚合执行（单轮单目标层）。
- 不做高级统计建模和预测分析。

## 2. 当前已实现能力清单

- 多服务注册：支持手动添加 `FeatureServer`，自动发现并注册全部子图层。
- 图层目录：支持服务/图层显隐控制，配置落盘持久化。
- 服务视角定位：支持按服务缩放到联合范围。
- 查询执行：支持 `search/count/group_stat/nearest/buffer_search`。
- 语义链路：支持 LLM（Groq/OpenRouter）解析，失败自动回退规则解析。
- 可解释性：返回 `parserSource`、`parserFailureReason`、`parserFailureDetail`、`normalizedByRule`。
- 字段治理：动态字段白名单、字段同义词映射、数值比较运算（`> >= < <=`）。
- 空间能力：支持点/线/面要素高亮；缓冲区按查询计划触发绘制。
- 跨图层缓冲：支持 `sourceLayer + sourceAttributeFilter`，源要素可多条自动合并后执行。

## 3. 当前未实现 / 规划中能力

- 多目标图层并行查询与聚合输出。
- 结果一键导出（Shapefile/GeoJSON/CSV）统一方案。
- 复杂空间分析（clip/intersect/union/overlay 等）。
- 流式回复（SSE/WebSocket）与增量渲染。
- 标准化离线评测集、自动评分与回归看板。

## 4. 架构总览

### 4.1 前端（Vue + Vite + TypeScript + ArcGIS JS）
- 会话式输入与结果卡片展示。
- 地图组件负责数据图层渲染、查询高亮、缓冲区绘制、视角控制。
- 图层管理抽屉负责服务注册、服务/图层显隐与交互入口。

### 4.2 后端（Node + Fastify）
- 统一 API 编排：语义解析、空间执行、聊天入口、图层目录管理。
- 图层注册中心（Layer Registry）负责目录、元数据和持久化。
- 查询编译器将 DSL 编译为 ArcGIS `/query` 参数并执行。

### 4.3 共享类型层（shared）
- DSL、QueryPlan、Parse/ExecuteResponse、LayerCatalog 等类型由 `@gis/shared` 统一约束。

### 4.4 外部依赖
- ArcGIS/GeoScene FeatureServer REST。
- OpenAI-compatible LLM provider（Groq/OpenRouter）。

## 5. 核心模块职责

### 5.1 `layer-registry`
- 服务注册/删除、子图层发现、字段抽取、配置持久化。
- 提供图层检索与默认图层选择能力。

### 5.2 `semantic`
- 规则语义解析与兜底路径。
- 条件句式提取、字段同义词映射、跨图层缓冲规则生成。

### 5.3 `semantic-llm`
- 模型提示词与 few-shot 组装。
- 模型输出结构化解析、层路由、一致性校验、失败归类与规则回退。

### 5.4 `semantic-normalizer`
- 对模型与规则产物执行统一归一化。
- 运算符纠偏、字段合法化、噪音词清理、失败原因标准化。

### 5.5 `compiler`
- DSL -> QueryPlan 编译。
- 字段合法性校验、where 生成、数值/文本比较约束。

### 5.6 `spatial-executor`
- 按 QueryPlan 调 ArcGIS REST。
- count/group_stat 可视化补查询。
- 跨图层缓冲的源要素查询、合并与执行。

### 5.7 `narrator`
- 将执行结果转换为业务可读总结文案。

### 5.8 `MapViewPanel`
- 数据图层同步、查询命中高亮、缓冲区绘制与视角跳转。

## 6. API 契约（当前）

- `POST /api/chat/query`
  - 对外统一入口：空间问题走语义+执行，非空间问题走普通聊天模型。
- `POST /api/semantic/parse`
  - 仅返回解析结果（DSL + followUpQuestion + parser metadata）。
- `POST /api/spatial/execute`
  - 输入 DSL，返回 QueryPlan + features + summary。
- `GET /api/layers/catalog`
  - 返回服务与子图层目录。
- `POST /api/layers/catalog/register`
  - 注册 FeatureServer 并自动发现子图层。
- `DELETE /api/layers/catalog/service/:serviceId`
  - 删除服务及其子图层。
- `PATCH /api/layers/catalog/layer/:layerKey`
  - 更新图层显隐与 queryable 标志。
- `GET /api/layers/meta`
  - 获取指定图层元数据。

## 7. 运行配置与安全约束

- 图层来源受 `ALLOWED_LAYER_HOSTS` 白名单限制。
- 模型调用受超时配置控制（Groq/OpenRouter timeout）。
- 查询规模受 `limit<=2000` 与服务 `maxRecordCount` 共同约束。
- 半径单位统一米/千米；执行坐标系统一按现有 Web Mercator 工作流。
- 禁止自由 SQL；字段必须来自目标层合法字段集合。
- 默认策略：模型优先，失败自动回退规则，保障可用性优先。

## 8. 质量门禁与验收

- DSL 必须通过 Schema 校验。
- 字段、运算符、输出字段必须通过目标层合法性校验。
- 全链路可追踪：`question -> dsl -> queryPlan -> summary`。
- 回退必须可诊断：返回失败原因与细节（reason/detail）。
- 功能验收需覆盖模型成功与规则回退两条路径，结果语义应一致。

## 9. 回归测试问句集（建议基线）

### 9.1 空间检索
- `鼓楼区公园有多少个`
- `名称包含“公园”的公园有哪些`
- `查找标准名称为南二环的道路街巷`

### 9.2 缓冲分析
- `x:13303000, y:2996000 附近2km内公园`
- `标准名称为南二环的道路街巷100米内的门牌号码`
- `OBJECTID：45854的宗地院落80米内的道路街巷`
- `面积小于100的宗地院落80米内的道路街巷`
- `周长不超过300的宗地院落80米内的道路街巷`

### 9.3 非空间对话
- `你好`
- `今天福州天气怎么样`

### 9.4 异常与降级
- 图层不可达、provider 超时、provider 401、Schema 失败、语义一致性冲突。

## 10. 后续演进路线

- Prompt 与 few-shot 数据集迭代，建立失败样例闭环。
- 增加空间语义离线评测集与成功率看板。
- 输出导出能力（Shapefile/GeoJSON）与大数据量分批机制。
- 流式响应（SSE/WebSocket）与会话记忆增强。

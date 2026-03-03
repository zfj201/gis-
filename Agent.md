# Agent.md - 空间语义解析项目实现总纲

## 1. 项目目标与非目标

### 1.1 目标
- 实现“自然语言 -> 结构化空间查询 -> ArcGIS REST 执行 -> 地图高亮 + 自然语言回复”的完整链路。
- 以点数据能力为第一优先级，逐步扩展到街道/县域等几何语义。

### 1.2 非目标
- 不实现自由 SQL 透传。
- 不实现数据编辑写回与权限体系。
- 不实现复杂网络分析与预测分析。

## 2. 总体架构

### 2.1 前端层（Vue + Vite + TypeScript + ArcGIS JS）
- 聊天输入与结果展示。
- 地图高亮（命中点、缓冲区、候选实体）。
- 歧义澄清交互（候选 street/county 二次选择）。

### 2.2 后端层（Node.js + Fastify）
- 接口编排：`/api/semantic/parse`、`/api/spatial/execute`、`/api/chat/query`、`/api/layers/meta`。
- 查询编译与 ArcGIS 调用。
- 错误归一化与降级。

### 2.3 语义层（LLM + 规则校验）
- LLM 负责槽位识别与意图判定。
- 规则负责字段白名单、半径上限、单位归一化、Schema 校验。

### 2.4 执行层（ArcGIS Query Compiler）
- DSL 编译为 ArcGIS REST `/query` 参数。
- geometry/spatialRel/outFields/orderBy/groupBy/outStatistics 统一生成。

### 2.5 共享类型层（DSL/DTO）
- 前后端共用 `SpatialQueryDSL`、API DTO、错误码与响应对象。

## 3. 模块职责

### 3.1 `semantic-parser`
- 输入：自然语言问题。
- 输出：`SpatialQueryDSL` + `confidence` + 可选 `followUpQuestion`。
- 约束：不得输出自由 SQL；必须输出 Schema 合法 JSON。

### 3.2 `geo-resolver`
- 输入：`locationEntity`。
- 输出：标准几何或候选列表。
- 责任：解析点/道路/行政区，处理地名歧义。

### 3.3 `query-compiler`
- 输入：`SpatialQueryDSL` + 解析几何。
- 输出：ArcGIS 查询参数与可审计 `queryPlan`。

### 3.4 `result-narrator`
- 输入：ArcGIS 查询结果。
- 输出：`summary`、统计结论、异常解释与澄清提示。

### 3.5 `map-presenter`
- 输入：`features`、缓冲几何、候选实体。
- 输出：地图图层高亮、弹窗与列表联动。

## 4. 开发优先级

### P0：仅公园点能力（无需额外数据）
- 属性检索（名称/地址/城市/区县）。
- count 与 group by 统计。
- 排序分页与地图高亮。
- 单轮问答与摘要回复。

### P1：点/街道/县缓冲查询（接入补充图层与 geocode）
- “某点100米内公园”。
- “某街道100米内公园”（road/subdistrict 分流）。
- “某县1km内公园”（默认含县内，可选 ringOnly）。

### P2：多轮对话、质量评估与监控
- 多轮上下文继承。
- 评测集回归测试。
- 指标告警与错误追踪。

## 5. 质量门禁
- DSL 必须通过 JSON Schema 校验。
- `field/operator/radius/limit` 必须通过白名单和上限校验。
- 查询链路必须产生日志：`question -> dsl -> queryPlan -> summary`。
- 每个能力必须有可复现验收样例与预期结果。

## 6. 运行约束与安全
- 严禁让 LLM 直接拼接自由 SQL。
- 坐标系统一到工作 SR（3857），单位统一到米。
- 默认半径建议值 5000m，系统硬上限 10000m。
- 外部依赖不可用时，降级到可执行子集（属性过滤/统计）。
- 歧义实体必须先澄清，不允许盲查。

## 7. 重要公共接口与类型

### 7.1 `SpatialQueryDSL` 字段
- `intent`
- `targetLayer`
- `locationEntity`
- `spatialFilter`（`buffer/intersects/nearest`）
- `attributeFilter`
- `aggregation`
- `sort`
- `limit`
- `output`

### 7.2 API
- `POST /api/semantic/parse`
- `POST /api/spatial/execute`
- `POST /api/chat/query`
- `GET /api/layers/meta`

### 7.3 响应标准对象
- `resolvedEntities`
- `queryPlan`
- `features`
- `summary`
- `followUpQuestion`

## 8. 实施约束与验收

### 8.1 实施顺序
1. 先完成“能力矩阵 + 数据依赖”的代码映射。
2. 再完成语义解析与查询编译。
3. 最后完成前端高亮、解释生成和监控埋点。

### 8.2 验收场景
- 无补充信息场景：
  - “鼓楼区公园有多少个”
  - “列出仓山区前20个公园名称”
  - “按区县统计公园数量”
- 需补充信息场景：
  - “东街口100米内的公园”
  - “某某街道100米内的公园”
  - “闽侯县1km内的公园”
- 异常与降级场景：
  - 地名歧义、外部服务超时、半径超限、图层不可达、坐标系不匹配。

## 9. 默认约定
- 文档与接口说明使用中文。
- 当前已确认业务图层为“福州市公园点”。
- 支持第三方服务接入，但需在配置中显式声明。
- 单位换算固定：`1km = 1000m`。

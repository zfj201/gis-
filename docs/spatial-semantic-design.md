# 空间语义解析项目设计文档（MVP -> V1）

## 1. 项目目标与范围

### 1.1 项目目标
构建一个“自然语言 -> 结构化空间查询 -> ArcGIS 查询执行 -> 地图可视化与自然语言回复”的端到端系统，重点解决 WebGIS 场景下的空间语义解析问题。

### 1.2 目标用户
- 业务用户：通过自然语言检索和统计公园点数据。
- GIS 分析人员：快速构造空间查询，降低 SQL/REST 参数门槛。

### 1.3 本阶段范围
- 前端：`Vue + Vite + TypeScript`，地图展示与结果高亮。
- 后端：`Node.js` 服务，语义解析、查询编译、执行与结果解释。
- 数据源：ArcGIS FeatureLayer（当前已知仅“福州市公园点”）。
- 查询能力：点数据相关查询、统计、分组统计、缓冲区、最近邻。

### 1.4 非目标
- 不在本阶段实现复杂拓扑分析、网络分析、时空预测。
- 不在本阶段实现编辑写回（applyEdits）和多租户权限体系。

## 2. 已知事实（基于当前公园点图层）

| 项目 | 值 |
|---|---|
| 图层 URL | `https://www.geosceneonline.cn/server/rest/services/Hosted/福州市公园点/FeatureServer/0` |
| 图层名称 | 福州市公园点 |
| geometryType | `esriGeometryPoint` |
| 坐标系 | `wkid=102100`，`latestWkid=3857` |
| objectIdField | `fid` |
| displayField | `名称` |
| maxRecordCount | 2000 |
| supportsStatistics | true |
| supportsAdvancedQueries | true |
| 字段 | `fid, objectid, 名称, x, y, 地址, 城市, 区县, field7` |
| capabilities | `Query` |

## 3. 能力分层矩阵

### 3.1 不必额外补充信息即可完成（仅依赖当前公园点 FeatureLayer）

| 能力 | 可完成度 | 依赖 | 说明 |
|---|---|---|---|
| 公园点属性检索（名称/地址/城市/区县） | 可完成 | 当前公园点图层 | 基于 `where` 模板和字段白名单。 |
| 数量统计（总数、按区县分组） | 可完成 | 当前公园点图层 | 使用 `returnCountOnly` 和 `groupByFieldsForStatistics=区县`。 |
| 排序与分页（名称、区县、限制条数） | 可完成 | 当前公园点图层 | 使用 `orderByFields`、`resultOffset`、`resultRecordCount`。 |
| 点数据基础问答（如“鼓楼区有多少公园”） | 可完成 | 规则 + LLM + 当前图层 | 语义解析后映射到统计查询。 |
| 地图高亮与结果解释 | 可完成 | 前端地图 SDK + 当前图层结果 | 返回 geometry 并在地图渲染。 |

### 3.2 需要补充额外信息后可以完成

| 能力 | 补充信息 | 依赖类型 | 说明 |
|---|---|---|---|
| “某点100米内公园” | 点坐标来源（地图点击/经纬度/geocode） | 必需 | 没有点几何无法执行空间过滤。 |
| “某街道100米内公园” | 道路中心线图层（polyline）或道路边界服务 | 必需 | street 语义需要线/面几何载体。 |
| “某县1km内公园” | 区县边界图层（polygon） | 必需 | 需要县界几何后缓冲再相交查询。 |
| 街道行政语义（subdistrict）查询 | 行政街道边界图层（polygon） | 必需 | 与道路 street 语义区分处理。 |
| 最近邻到指定目标点 | 目标点解析服务与距离计算策略 | 必需 | 需要可解析目标点几何。 |
| 缓冲区可视化分析 | SR 统一规则与缓冲计算策略 | 必需 | 保证单位换算和距离含义一致。 |

## 4. 系统架构与数据流

### 4.1 架构分层
- 前端层：对话输入、地图渲染、结果高亮、澄清交互。
- 语义层：NL 解析、槽位提取、DSL 生成、Schema 校验。
- 执行层：地理实体解析、查询编译、ArcGIS REST 执行。
- 回答层：结果标准化、摘要生成、异常与澄清回复。

### 4.2 端到端流程
1. 用户输入自然语言问题。
2. `semantic-parser` 输出 `SpatialQueryDSL`。
3. `dsl-validator` 做字段白名单和半径上限校验。
4. `geo-resolver` 解析位置实体（点/线/面）。
5. `query-compiler` 生成 ArcGIS `/query` 参数。
6. ArcGIS 返回 feature 集。
7. `result-narrator` 输出自然语言摘要和可视化元数据。
8. 前端高亮命中点、缓冲区和候选实体。

### 4.3 核心组件
- `semantic-parser`：LLM + 规则混合解析，输出结构化 JSON。
- `geo-resolver`：将地点名、行政区、道路名解析为几何。
- `query-compiler`：将 DSL 编译为 ArcGIS 可执行参数。
- `arcgis-client`：执行 REST 请求并处理分页、异常、重试。
- `result-narrator`：把结果转成中文业务可读解释。

## 5. 查询语义到空间执行规则

### 5.1 规则总则
- 所有自然语言先归一化到 `SpatialQueryDSL`。
- 单位统一：`1km = 1000m`。
- 默认半径上限：5000m；后端硬校验上限 10000m。
- 默认坐标系工作 SR：3857；输入几何统一投影后执行查询。
- LLM 只负责结构化语义，不直接拼接自由 SQL。

### 5.2 三类关键句式

#### A. “某个街道100米内的公园”
1. 识别 `街道` 语义类型：`road` 或 `subdistrict`。
2. `road`：解析道路线几何（polyline）后做 100m 缓冲。
3. `subdistrict`：解析行政街道面几何（polygon）后外扩 100m。
4. 用缓冲几何与公园点做 `intersects` 查询。
5. 若同名歧义，返回候选列表并设置 `followUpQuestion`。

#### B. “某个点100米内的公园”
1. 若输入为坐标，直接构造点几何。
2. 若输入为地名，先 geocode 到点几何。
3. 坐标统一到工作 SR 后，做 100m 缓冲相交查询。

#### C. “某个县1km内的公园”
1. 解析县界 polygon。
2. 县界外扩 1000m 后与公园点做相交查询。
3. 默认返回“含县内 + 外扩区”结果。
4. 可选参数 `ringOnly=true` 表示仅返回县界外环带结果。

## 6. 外部依赖与补充数据清单

### 6.1 强依赖（启用对应能力时必须具备）
| 依赖项 | 用途 |
|---|---|
| 道路中心线图层（polyline） | 支持 `road` 语义与道路缓冲查询。 |
| 行政街道边界图层（polygon） | 支持 `subdistrict` 语义查询。 |
| 区县边界图层（polygon） | 支持“某县 X km 内”查询。 |
| 地名 geocode 服务 | 支持“某点/某地名附近”解析。 |

### 6.2 可选依赖（可提升精度与稳定性）
| 依赖项 | 作用 |
|---|---|
| 候选实体排序服务 | 提高歧义地名命中率。 |
| 坐标转换服务 | 提高多坐标输入稳定性。 |
| 结果缓存（Redis） | 降低重复查询延迟。 |

### 6.3 无外部补充时的降级能力
- 仅提供公园点属性过滤、统计、分组统计、排序分页、地图高亮与文本摘要。
- 对于“街道/县/地名半径查询”，返回可执行澄清提示和缺失依赖说明。

## 7. API 与 DSL 契约

### 7.1 `SpatialQueryDSL`（核心公共类型）

```json
{
  "intent": "search|count|group_stat|nearest|buffer_search",
  "targetLayer": "fuzhou_parks",
  "locationEntity": {
    "rawText": "东街口",
    "type": "point|road|subdistrict|county|unknown"
  },
  "spatialFilter": {
    "type": "buffer|intersects|nearest",
    "radius": 100,
    "unit": "meter",
    "ringOnly": false
  },
  "attributeFilter": [
    { "field": "区县", "operator": "=", "value": "鼓楼区" }
  ],
  "aggregation": {
    "type": "count|group_count",
    "groupBy": ["区县"]
  },
  "sort": { "by": "distance|名称|区县", "order": "asc|desc" },
  "limit": 20,
  "output": {
    "fields": ["fid", "名称", "地址", "区县"],
    "returnGeometry": true
  }
}
```

### 7.2 后端 API

#### `POST /api/semantic/parse`
- 输入：`{ "question": "鼓楼区有多少公园" }`
- 输出：`{ "dsl": SpatialQueryDSL, "confidence": 0.92, "followUpQuestion": null }`

#### `POST /api/spatial/execute`
- 输入：`{ "dsl": SpatialQueryDSL }`
- 输出：
```json
{
  "resolvedEntities": [],
  "queryPlan": {
    "layer": ".../FeatureServer/0",
    "where": "区县 = '鼓楼区'",
    "geometry": null,
    "spatialRel": null
  },
  "features": [],
  "summary": "鼓楼区共检索到 18 个公园",
  "followUpQuestion": null
}
```

#### `POST /api/chat/query`
- 输入：`{ "question": "闽侯县1km内的公园" }`
- 输出：`parse + execute` 聚合结果，供前端单次渲染。

#### `GET /api/layers/meta`
- 输出：图层字段、SR、能力信息、可用查询模板。

### 7.3 响应标准对象
- `resolvedEntities`：实体解析结果与候选。
- `queryPlan`：可审计的最终查询计划。
- `features`：标准化 GIS 要素列表。
- `summary`：自然语言摘要。
- `followUpQuestion`：歧义澄清问题。

## 8. 风险、监控与降级策略

### 8.1 主要风险
- 地名歧义导致解析错误。
- 外部服务超时导致查询链路阻塞。
- 坐标系不一致导致空间结果偏差。
- 大半径查询导致性能退化。

### 8.2 监控指标
- `parse_latency_ms`、`execute_latency_ms`、`end_to_end_latency_ms`
- `query_success_rate`、`timeout_rate`、`fallback_rate`
- `avg_result_count`、`empty_result_rate`
- `ambiguity_trigger_rate`（触发澄清比例）

### 8.3 降级策略
1. geocode/边界服务不可用时，回退到纯属性查询能力。
2. 半径超限时拒绝执行并返回可调整建议。
3. 图层不可达时返回“服务异常”并保留可重试参数。
4. 对歧义实体不盲查，必须走 `followUpQuestion`。

## 9. 里程碑与验收标准

### 9.1 里程碑
- M1（P0）：仅公园点能力上线（属性过滤 + 统计 + 地图高亮）。
- M2（P1）：点/街道/县缓冲查询（接入 geocode 与边界图层）。
- M3（P2）：多轮上下文、质量评测、稳定性监控。

### 9.2 验收样例

#### 无补充信息场景
1. “鼓楼区公园有多少个” -> 返回 count 与摘要。
2. “列出仓山区前20个公园名称” -> 返回排序列表。
3. “按区县统计公园数量” -> 返回分组统计结果。

#### 需补充信息场景
1. “东街口100米内的公园” -> geocode 后返回缓冲命中结果。
2. “某某街道100米内的公园” -> 道路/行政街道几何解析后返回结果。
3. “闽侯县1km内的公园” -> 县界缓冲后返回结果。

#### 异常与降级场景
1. 地名歧义：返回候选和澄清问题。
2. 外部服务超时：返回降级结果与重试建议。
3. 半径超限：拒绝执行并提示上限。
4. 图层不可达：返回可重试错误码。
5. 坐标系不匹配：自动投影或返回可识别错误。

## 10. 假设与默认值
- 文档语言：中文。
- 当前唯一已确认业务图层：福州市公园点（点要素）。
- 可接入第三方服务，但必须在运行时显式标注强依赖/可选依赖。
- 单位换算固定：`1km = 1000m`。
- 默认查询半径建议值：5000m，系统硬上限 10000m。
- 本文档阶段只定义方案与契约，不包含代码实现。

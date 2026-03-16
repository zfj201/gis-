# DSL 能力增强评测报告

- 生成时间：2026/3/16 17:42:24
- 样例来源：46 条主样例 + 46 条变体样例，共 92 条
- 对比口径：
  - baseline：旧的 `parseQuestion(...)` 规则解析结果
  - profile：新的 `RuleProfile + DSL v2 + operator registry` 骨架结果
- 说明：这份报告衡量的是“分析结构正确率”，不是最终 ArcGIS 执行结果正确率。

## 总览

| 指标 | 样例数 | baseline | profile | 提升 |
| --- | ---: | ---: | ---: | ---: |
| Intent 正确率 | 54 | 47 (87.0%) | 48 (88.9%) | +1 |
| Analysis family 正确率 | 56 | 47 (83.9%) | 49 (87.5%) | +2 |
| Operator skeleton 正确率 | 44 | 36 (81.8%) | 39 (88.6%) | +3 |
| 应追问场景识别率 | 20 | 20 (100.0%) | 20 (100.0%) | +0 |

## 结论

- 新增算子后，最直接的收益不是“回答更多”，而是“更少把问题判错类型”。
- 统计类、缓冲类缺槽位场景、overlay 识别场景的结构正确率提升最明显。
- overlay 类现在已经能稳定识别为 `clip / erase / dissolve / union_overlay` 等家族，并阻止错误降级成普通检索。
- 对现有能力的增强主要体现在：更强的分组统计识别、几何来源合法性约束、以及模型越权后的结构拦截。

## 典型改进样例

- T-045 按道路级别统计道路街巷数量
  - baseline: intent=count, family=aggregate, ops=aggregate_count,sort,limit
  - profile: intent=group_stat, family=aggregate, ops=aggregate_group,sort,limit
  - followUp: baseline=no, profile=no
- T-046 裁剪出某区县内的道路街巷
  - baseline: intent=buffer_search, family=buffer, ops=buffer,spatial_predicate,limit
  - profile: intent=-, family=overlay, ops=clip
  - followUp: baseline=yes, profile=yes
- T-046 把区县范围内的道路街巷裁剪出来
  - baseline: intent=buffer_search, family=buffer, ops=buffer,spatial_predicate,limit
  - profile: intent=-, family=overlay, ops=clip
  - followUp: baseline=yes, profile=yes

## 建议

- 这份报告已经能回答“新增算子是否提升现有能力”：答案是会，尤其提升结构正确率和安全性。
- 下一步如果要衡量真实业务正确率，建议再补一层“接口结果断言”，对 count/groupBy/sourceLayer/followUp 文案做精确校验。
- overlay 真正执行器接上后，可以沿用这份脚本继续做 before/after 对比。

# CODEX_LOG

## 2026-03-05 P1.5 新图层零补丁语义稳健化（本次范围）

### 目标
- 收敛“新图层不进空间链路”和“字段值尾巴污染”问题。
- 补齐 P1.5 缺口：画像上下文注入、低置信提示、onboarding 冒烟用例生成、回归报告 service 维度统计。

### 本次实现
1. 修复与完善语义上下文构建
   - 修复 `/Users/fangjiezheng/project/gis/backend/src/semantic-context-builder.ts` 的参数调用不一致问题。
   - 检索上下文新增图层语义画像摘要（roles/tokens/valueHints），并限制展示规模。

2. 稳定值清洗与编译兜底
   - 修复 `/Users/fangjiezheng/project/gis/backend/src/compiler.ts` 集合值清洗回调遗漏返回值的问题。
   - 继续复用 `semantic-slot-parser` 进行 in/not in 与尾巴词清洗。

3. Prompt 约束增强
   - `/Users/fangjiezheng/project/gis/backend/src/prompts/semantic.ts` 增补：
     - admin 字段 value 禁止夹带图层实体尾巴；
     - in/not in 仅允许纯集合元素，禁止“中/里/内/之中/列表”等尾巴词。

4. 回归报告可观测性增强
   - `/Users/fangjiezheng/project/gis/backend/scripts/run-chat-regression.ts`：
     - 记录扩展 `semanticMeta`（gateDecision/candidateCount/chosenCandidate/candidateScore）；
     - 按 `serviceId` 聚合统计 pass/warn/fail；
     - 明细表新增 service 与候选评分字段。

5. onboarding 用例自动生成脚本
   - 新增 `/Users/fangjiezheng/project/gis/backend/scripts/generate-layer-smoke-cases.ts`。
   - 新增命令：
     - `/Users/fangjiezheng/project/gis/backend/package.json` -> `test:chat-onboarding`
     - `/Users/fangjiezheng/project/gis/package.json` -> `test:chat:onboarding`
   - 输出路径：`/Users/fangjiezheng/project/gis/backend/testcases/chat-query-cases-onboarding-<serviceId>.json`

6. 前端低置信澄清提示
   - `/Users/fangjiezheng/project/gis/frontend/src/App.vue` 扩展 semanticMeta 展示（candidateScore/chosenCandidate/gateDecision）。
   - 当 `candidateScore < 75` 且存在 followUp 时，显示“低置信度，已进入澄清以避免误查”。
   - `/Users/fangjiezheng/project/gis/frontend/src/style.css` 新增 `msg-warn` 样式。

7. 使用文档同步
   - `/Users/fangjiezheng/project/gis/README.md` 增补 onboarding 脚本使用方式。
   - 回归说明同步新增 semanticMeta 字段与 service 维度统计说明。

8. 距离单位一致性修复（公里/米）
   - 新增 `/Users/fangjiezheng/project/gis/backend/src/spatial-distance.ts`，统一距离单位换算工具。
   - `/Users/fangjiezheng/project/gis/backend/src/semantic-normalizer.ts` 新增“按问句显式单位矫正半径”逻辑：
     - 如问句出现“500公里”，自动归一到 `radius=500000, unit=meter`，避免模型把公里按米执行。
   - `/Users/fangjiezheng/project/gis/backend/src/compiler.ts` 与 `/Users/fangjiezheng/project/gis/backend/src/spatial-executor.ts` 全链路按米执行前统一换算，避免 unit=kilometer 时执行偏差。

9. TopK 句式扩展修复（“最近的五个”）
   - `/Users/fangjiezheng/project/gis/backend/src/semantic-limit.ts` 扩展 TopK 识别：
     - 原先仅识别“前N”，现支持“最近的N个 / N个最近 / 前N”。
     - 兼容全角数字（如 `前５个`）。
   - `/Users/fangjiezheng/project/gis/backend/src/prompts/semantic.ts` 同步约束文案为“前N/N个”。

10. 地图底图异常与 goTo 稳定性修复
   - `/Users/fangjiezheng/project/gis/frontend/src/components/MapViewPanel.vue` 增加 `safeGoTo` 与 `ensureViewReady`：
     - `goTo` 前先等待 `view.when()`，避免 `animation` 未初始化异常；
     - 发生 animation 相关异常时自动降级为 `animate:false` 再尝试一次。
   - 新增底图失败降级：
     - 监听 `layerview-create-error`，当矢量底图加载失败时降级为空底图，保证业务图层可继续使用。

### 验证
- 构建验证：
  - `npm run build` 通过。
  - `npm run build -w backend && npm run build -w frontend` 通过。
- 脚本验证：
  - `npm run test:chat:onboarding` 通过，成功生成 onboarding 用例文件。
  - `npm run test:chat -- --max-cases=2` 通过，报告包含 service 维度统计与扩展 semanticMeta 字段。
- 关键问句点查（本地解析）：
  - `查询County为会泽县的汉族传统村落` -> 正确进入空间链路并提取 `county='会泽县'`。
  - `objectid不在45854、45855中的宗地院落` -> `not in` 值清洗有效。
  - `fid：79的传统村落附近500公里` -> 解析后半径归一为 `500000米`，单位不再丢失。
  - `fid：79的传统村落最近的五个传统村落` -> TopK 可识别为 `limit=5`，不再被默认成 `Top1`。
  - 前端 `goTo` 相关控制台异常（animation undefined）已通过 ready+fallback 机制兜底。

### 风险与后续
- onboarding 生成句式当前更偏“可执行冒烟”，可继续按业务语料优化自然度。
- `docs/ai/ai-constraints.md` 当前仓库中不存在，后续建议补齐以免规则入口缺失。

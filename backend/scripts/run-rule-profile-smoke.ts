import assert from "node:assert/strict";
import { adaptAnalysisDslV2ToLegacy } from "../src/analysis-dsl-adapter.js";
import { validateAnalysisDslOperators } from "../src/operator-registry.js";
import { layerRegistry } from "../src/layer-registry.js";
import {
  buildRuleProfile,
  validateRuleProfileConsistency
} from "../src/semantic-rule-profile.js";

async function main(): Promise<void> {
  await layerRegistry.init();

  const groupProfile = buildRuleProfile("按道路级别统计道路街巷数量");
  assert.equal(groupProfile.analysisFamily, "aggregate");
  assert.ok(groupProfile.lockedOperators.includes("aggregate_group"));
  assert.equal(groupProfile.legacySeedDsl?.aggregation?.groupBy?.[0], "道路级别");

  const groupAdapted = adaptAnalysisDslV2ToLegacy(groupProfile.analysisDsl);
  assert.equal(groupAdapted.supported, true);
  assert.equal(groupAdapted.dsl?.intent, "group_stat");
  assert.equal(groupAdapted.dsl?.aggregation?.groupBy?.[0], "道路级别");
  assert.deepEqual(validateAnalysisDslOperators(groupProfile.analysisDsl), []);

  const bufferProfile = buildRuleProfile("南二环100米内的门牌号码");
  assert.ok(bufferProfile.lockedOperators.includes("buffer"));
  assert.ok(bufferProfile.lockedOperators.includes("spatial_predicate"));
  assert.equal(bufferProfile.actionable, false);
  assert.ok(bufferProfile.requiredSlots.includes("bufferSource"));
  assert.ok(validateAnalysisDslOperators(bufferProfile.analysisDsl).includes("buffer 缺少合法的几何来源"));

  const nearestProfile = buildRuleProfile("OBJECTID为45854的宗地院落最近的公园前3个");
  assert.equal(nearestProfile.analysisFamily, "nearest");
  assert.ok(nearestProfile.lockedOperators.includes("nearest"));
  assert.equal(nearestProfile.legacySeedDsl?.spatialFilter?.sourceLayer !== undefined, true);

  const overlayProfile = buildRuleProfile("裁剪出某区县内的道路街巷");
  assert.equal(overlayProfile.analysisFamily, "overlay");
  assert.equal(overlayProfile.actionable, false);
  assert.match(overlayProfile.followUpQuestion ?? "", /clip/i);

  const mutatedGroup = {
    dsl: {
      ...groupProfile.legacySeedDsl!,
      intent: "count" as const,
      aggregation: { type: "count" as const }
    },
    confidence: 0.9,
    followUpQuestion: null,
    parserSource: "rule" as const
  };
  assert.ok(validateRuleProfileConsistency(groupProfile, mutatedGroup).length > 0);

  console.log("RULE_PROFILE_SMOKE_PASS");
}

void main();

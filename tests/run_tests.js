"use strict";
const assert = require("assert");
const foodsMod = require("../engine/foods");
const { getRequirement } = require("../engine/requirements");
const { planDay, ratios, K } = require("../engine/constraints");
const { weekPlan, PROTEIN_KINDS } = require("../engine/menu");

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok  -", name);
  } catch (e) {
    failed++;
    console.log("FAIL -", name, "::", e.message);
  }
}

const PROF = { age_group: "adult_m", activity: "moderate", goal: "maintain" };
const NUTRIENTS = ["kcal", "protein", "fat", "carb", "fiber", "sodium", "potassium", "calcium", "iron", "vitA", "vitC", "vitD"];

/* ---------- 数据库完整性 ---------- */
t("食材 id 唯一且营养素字段齐全", () => {
  const ids = new Set();
  for (const f of foodsMod.FOODS) {
    assert(!ids.has(f.id), "重复 id: " + f.id);
    ids.add(f.id);
    for (const k of NUTRIENTS) {
      assert(typeof f.per100g[k] === "number" && isFinite(f.per100g[k]), f.id + " 缺字段 " + k);
      assert(f.per100g[k] >= 0, f.id + " 字段为负 " + k);
    }
  }
});

t("可食部比例与单价合法", () => {
  for (const f of foodsMod.FOODS) {
    assert(f.edible_ratio > 0 && f.edible_ratio <= 1, f.id + " 可食部非法");
    assert(f.cost > 0, f.id + " 单价非法");
  }
});

t("能量守恒：蛋白4+脂肪9+碳水4 与热量偏差在 20% 内", () => {
  for (const f of foodsMod.FOODS) {
    const calc = f.per100g.protein * 4 + f.per100g.fat * 9 + f.per100g.carb * 4;
    const rel = Math.abs(calc - f.per100g.kcal) / f.per100g.kcal;
    assert(rel <= 0.2, f.id + " 能量偏差 " + (rel * 100).toFixed(1) + "%");
  }
});

t("过敏原标签均来自合法集合", () => {
  for (const f of foodsMod.FOODS) {
    for (const a of f.allergens) {
      assert(foodsMod.ALLERGENS.includes(a), f.id + " 未知过敏原 " + a);
    }
  }
});

t("限次食材为每周限次且为正值", () => {
  const limited = foodsMod.FOODS.filter(f => f.weekly_limit != null);
  assert(limited.length >= 1);
  for (const f of limited) assert(f.weekly_limit >= 1);
});

/* ---------- 参考摄入量 ---------- */
t("不同性别分层摄入量不同", () => {
  const m = getRequirement({ age_group: "adult_m", activity: "light", goal: "maintain" });
  const f = getRequirement({ age_group: "adult_f", activity: "light", goal: "maintain" });
  assert(m.kcal > f.kcal);
  assert(f.iron > m.iron);
});

t("活动水平与目标调整系数生效", () => {
  const light = getRequirement({ age_group: "adult_m", activity: "light", goal: "maintain" });
  const heavy = getRequirement({ age_group: "adult_m", activity: "heavy", goal: "maintain" });
  const lose = getRequirement({ age_group: "adult_m", activity: "moderate", goal: "lose" });
  const gain = getRequirement({ age_group: "adult_m", activity: "moderate", goal: "gain" });
  assert(heavy.kcal > light.kcal);
  assert(lose.kcal < light.kcal);
  assert(gain.kcal > light.kcal);
  assert(gain.protein > light.protein);
});

/* ---------- 单日规划 ---------- */
const plan = planDay({ profile: PROF, budget: 25, allergens: [], exclude: [] });

t("基础画像单日规划可行", () => {
  assert.strictEqual(plan.feasible, true, plan.reasons.join(";"));
});

t("热量落在目标 ±5% 区间", () => {
  const req = getRequirement(PROF);
  assert(plan.totals.kcal >= req.kcal * 0.95 && plan.totals.kcal <= req.kcal * 1.05);
});

t("宏量营养素供能比达标", () => {
  assert(plan.ratios.fat >= 0.20 && plan.ratios.fat <= 0.30, "脂肪比 " + plan.ratios.fat);
  assert(plan.ratios.protein >= 0.10 && plan.ratios.protein <= 0.20, "蛋白比 " + plan.ratios.protein);
  assert(plan.ratios.carb >= 0.50 && plan.ratios.carb <= 0.65, "碳水比 " + plan.ratios.carb);
});

t("三大供能比之和约等于 1", () => {
  const s = plan.ratios.fat + plan.ratios.protein + plan.ratios.carb;
  assert(Math.abs(s - 1) < 0.08, "和=" + s);
});

t("成本不超过预算容差", () => {
  assert(plan.totals.cost <= 25 * 1.02);
});

t("三餐结构完整：每餐含主食且有蛋白来源", () => {
  for (const meal of ["breakfast", "lunch", "dinner"]) {
    const its = plan.items.filter(i => i.meal === meal);
    assert(its.some(i => ["staple"].includes(i.role)), meal + " 缺主食");
    assert(its.some(i => ["protein", "dairy_egg"].includes(i.role)), meal + " 缺蛋白来源");
  }
  assert(plan.items.filter(i => i.role === "protein").length >= 2);
});

t("克重按可食部折算：毛重与营养素一致", () => {
  const item = plan.items[0];
  const f = foodsMod.getFood(item.food_id);
  const n = foodsMod.nutrientsFor(f, item.grams);
  assert(Math.abs(n.protein - item.grams * f.edible_ratio * f.per100g.protein / 100) < 1e-6);
});

t("同参数两次规划结果一致（确定性）", () => {
  const a = planDay({ profile: PROF, budget: 25, allergens: [], exclude: [] });
  const b = planDay({ profile: PROF, budget: 25, allergens: [], exclude: [] });
  assert.strictEqual(JSON.stringify(a.items), JSON.stringify(b.items));
  assert.strictEqual(a.totals.kcal, b.totals.kcal);
});

/* ---------- 过敏原与排除 ---------- */
const MILK_IDS = ["milk_full", "yogurt", "cheese"];
const SOY_IDS = ["tofu_north", "tofu_south", "soymilk", "soybean", "yuba"];
const FISH_IDS = ["salmon", "cod", "bass"];

t("排除乳制品过敏原", () => {
  const r = planDay({ profile: PROF, budget: 25, allergens: ["乳"], exclude: [] });
  assert.strictEqual(r.feasible, true, r.reasons.join(";"));
  assert(!r.items.some(i => MILK_IDS.includes(i.food_id)));
});

t("排除大豆过敏原", () => {
  const r = planDay({ profile: PROF, budget: 25, allergens: ["大豆"], exclude: [] });
  assert.strictEqual(r.feasible, true, r.reasons.join(";"));
  assert(!r.items.some(i => SOY_IDS.includes(i.food_id)));
});

t("排除鱼类过敏原", () => {
  const r = planDay({ profile: PROF, budget: 25, allergens: ["鱼"], exclude: [] });
  assert.strictEqual(r.feasible, true, r.reasons.join(";"));
  assert(!r.items.some(i => FISH_IDS.includes(i.food_id)));
});

t("exclude 指定食材不出现在结果", () => {
  const r = planDay({ profile: PROF, budget: 25, allergens: [], exclude: ["broccoli", "chicken_breast"] });
  assert.strictEqual(r.feasible, true, r.reasons.join(";"));
  assert(!r.items.some(i => ["broccoli", "chicken_breast"].includes(i.food_id)));
});

t("排除全部肉蛋后以豆制品兜底（素食可用）", () => {
  const meatEggs = foodsMod.FOODS.filter(f => f.cat === "meat").map(f => f.id);
  const r = planDay({ profile: PROF, budget: 25, allergens: [], exclude: meatEggs });
  assert.strictEqual(r.feasible, true, r.reasons.join(";"));
  assert(!r.items.some(i => meatEggs.includes(i.food_id)));
  assert(r.items.some(i => SOY_IDS.includes(i.food_id)));
});

t("每周限次：已用尽猪肝则当日不再出现", () => {
  const r = planDay({ profile: PROF, budget: 25, allergens: [], exclude: [], weekly_used: { pork_liver: 1 } });
  assert(!r.items.some(i => i.food_id === "pork_liver"));
});

/* ---------- 预算与不可行 ---------- */
t("极端低预算：成本受限或诚实报告不可行", () => {
  const r = planDay({ profile: PROF, budget: 8, allergens: [], exclude: [] });
  if (r.feasible) {
    assert(r.totals.cost <= 8 * 1.02);
  } else {
    assert(r.reasons.length > 0);
  }
});

t("排除全部食材时返回不可行", () => {
  const all = foodsMod.FOODS.map(f => f.id);
  const r = planDay({ profile: PROF, budget: 25, allergens: [], exclude: all });
  assert.strictEqual(r.feasible, false);
  assert(r.items.length === 0 || r.reasons.length > 0);
});

t("增肌高能耗画像在宽松预算下可行", () => {
  const r = planDay({ profile: { age_group: "teen_m", activity: "heavy", goal: "gain" }, budget: 40, allergens: [], exclude: [] });
  assert.strictEqual(r.feasible, true, r.reasons.join(";"));
});

/* ---------- 周菜单 ---------- */
const week = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });

t("周菜单 7 天全部可行", () => {
  assert.strictEqual(week.feasible, true);
  assert.strictEqual(week.days.length, 7);
});

t("每天餐次完整（≥12 项）", () => {
  for (const d of week.days) {
    assert(d.items.length >= 12, d.day_name + " 仅 " + d.items.length + " 项");
  }
});

t("相邻两天不重复食材", () => {
  for (let d = 1; d < 7; d++) {
    const prev = new Set(week.days[d - 1].items.map(i => i.food_id));
    for (const it of week.days[d].items) {
      assert(!prev.has(it.food_id), week.days[d].day_name + " 与前一天重复: " + it.food_id);
    }
  }
});

t("午餐蛋白质类别逐日不同", () => {
  const kindsOf = id => PROTEIN_KINDS.find(k => k.ids.includes(id));
  const seen = [];
  for (let d = 0; d < 7; d++) {
    const lunch = week.days[d].items.find(i => i.meal === "lunch" && i.role === "protein");
    assert(lunch, week.days[d].day_name + " 午餐缺蛋白");
    const kind = kindsOf(lunch.food_id);
    assert(kind, lunch.food_id + " 无类别");
    if (d > 0) assert(kind.kind !== seen[d - 1], "相邻天午餐类别重复: " + kind.kind);
    seen.push(kind.kind);
  }
  assert(new Set(seen).size >= 5, "全周午餐类别仅 " + new Set(seen).size + " 种");
});

t("全周蛋白质来源类别多样", () => {
  assert(week.diversity.protein_kinds >= 5, "蛋白类别 " + week.diversity.protein_kinds);
});

t("肝脏每周至多 1 次且按计划出现", () => {
  assert.strictEqual(week.diversity.liver_count, 1);
});

t("周成本为正且每日成本未超预算容差", () => {
  assert(week.weekly_cost > 0);
  for (const d of week.days) {
    assert(d.cost <= 30 * 1.02, d.day_name + " 成本 " + d.cost);
  }
});

t("周菜单确定性", () => {
  const a = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  const b = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  assert.strictEqual(JSON.stringify(a.days.map(x => x.items)), JSON.stringify(b.days.map(x => x.items)));
});

t("减重画像周菜单可行", () => {
  const w = weekPlan({ profile: { age_group: "adult_f", activity: "moderate", goal: "lose" }, budget: 25, allergens: [], exclude: [] });
  assert.strictEqual(w.feasible, true, w.days.map(d => d.reasons.join(";")).join("|"));
  assert(w.diversity.liver_count <= 1);
});

t("周菜单过敏原过滤全局生效", () => {
  const w = weekPlan({ profile: PROF, budget: 30, allergens: ["乳"], exclude: [] });
  assert.strictEqual(w.feasible, true);
  for (const d of w.days) {
    assert(!d.items.some(i => MILK_IDS.includes(i.food_id)));
  }
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

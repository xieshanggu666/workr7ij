"use strict";
/* 周菜单生成：7 天 × 三餐，蛋白质来源逐日轮换、主食轮换、相邻天不重复食材，
   肝脏全周至多 1 次，输出每日营养汇总与多样性统计。 */

const { FOODS, getFood } = require("./foods");
const { planDay, purchaseState } = require("./constraints");

const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const STAPLE_ROTATION = [
  ["rice_long", "brown_rice"], ["oatmeal", "steamed_bun"], ["buckwheat", "rice_long"],
  ["sweet_potato", "corn"], ["spaghetti", "brown_rice"], ["millet", "whole_wheat_bread"],
  ["rice_round", "potato"],
];

const LUNCH_STAPLE = ["rice_long", "brown_rice", "buckwheat", "spaghetti", "steamed_bun"];
const DINNER_STAPLE = ["rice_round", "brown_rice", "sweet_potato", "corn", "potato"];

const PROTEIN_KINDS = [
  { kind: "禽肉", ids: ["chicken_breast", "chicken_thigh"] },
  { kind: "猪肉", ids: ["pork_lean", "pork_liver"] },
  { kind: "牛肉", ids: ["beef_tenderloin", "beef_brisket"] },
  { kind: "羊肉", ids: ["lamb_lean"] },
  { kind: "鱼类", ids: ["salmon", "cod", "bass"] },
  { kind: "虾贝", ids: ["shrimp", "scallop"] },
  { kind: "豆制品", ids: ["tofu_north", "tofu_south", "yuba", "soybean"] },
];

const VEG_ROTATION = [
  ["broccoli", "tomato", "cucumber", "carrot"],
  ["spinach", "mushroom", "green_pepper", "white_gourd"],
  ["cabbage", "eggplant", "pumpkin", "onion"],
  ["red_cabbage", "celery", "lettuce", "broccoli"],
  ["asparagus", "cucumber", "tomato", "spinach"],
  ["carrot", "white_gourd", "mushroom", "cabbage"],
  ["lettuce", "pumpkin", "celery", "red_cabbage"],
];

const FRUIT_ROTATION = [
  ["apple", "banana"], ["orange", "pear"], ["kiwi", "grape"], ["strawberry", "apple"],
  ["blueberry", "orange"], ["banana", "pear"], ["grape", "kiwi"],
];

const ALL_PROTEIN = PROTEIN_KINDS.flatMap(k => k.ids);

/* 午餐蛋白按日轮换 kind；晚餐避开当日与次日午餐类别（保证次日午餐可用） */
function buildDayPools(d, params) {
  const staples = STAPLE_ROTATION[d % 7];
  const proteinKind = PROTEIN_KINDS[d % 7];
  const nextKind = PROTEIN_KINDS[(d + 1) % 7];
  const lunchProtein = proteinKind.ids.filter(id => id !== "pork_liver");
  let dinnerProtein = ALL_PROTEIN.filter(id => !proteinKind.ids.includes(id) && !nextKind.ids.includes(id));
  if (d === 1 && proteinKind.kind === "猪肉") {
    dinnerProtein = ["pork_liver"];
  }
  return {
    breakfast_staple: staples,
    lunch_staple: [LUNCH_STAPLE[d % LUNCH_STAPLE.length], LUNCH_STAPLE[(d + 2) % LUNCH_STAPLE.length]],
    dinner_staple: [DINNER_STAPLE[(d + 1) % DINNER_STAPLE.length], DINNER_STAPLE[(d + 3) % DINNER_STAPLE.length]],
    lunch_protein: lunchProtein,
    dinner_protein: dinnerProtein,
    veg: VEG_ROTATION[d % VEG_ROTATION.length],
    fruit: FRUIT_ROTATION[d % FRUIT_ROTATION.length],
  };
}

function weekPlan(params) {
  const days = [];
  /* 外部传入的本周已用次数（如已消耗天数的限次计数）与库存（毛重克）逐日结转 */
  const weeklyUsed = { ...(params.weekly_used || {}) };
  const stockLive = params.stock ? { ...params.stock } : null;
  let prevIds = new Set();

  for (let d = 0; d < 7; d++) {
    const dayPools = buildDayPools(d, params);
    const runDay = (relaxed) => planDay({
      ...params,
      exclude: relaxed ? [...(params.exclude || [])] : [...(params.exclude || []), ...prevIds],
      weekly_used: weeklyUsed,
      day_pools: dayPools,
      stock: stockLive,
    });
    let result = runDay(false);
    if (!result.feasible) {
      result = runDay(true);
    }
    const ids = result.items.map(i => i.food_id);
    ids.forEach(id => { weeklyUsed[id] = (weeklyUsed[id] || 0) + 1; });
    /* 当日配餐消耗在库余量，剩余库存结转到次日，保证后续配餐优先用库存 */
    let dayPurchase = result.totals.cost;
    if (stockLive) {
      const ps = purchaseState(result.items, stockLive);
      dayPurchase = ps.purchase_cost;
      for (const [id, g] of Object.entries(ps.remaining)) stockLive[id] = g;
      for (const id of result.items.map(i => i.food_id)) {
        if (stockLive[id] < 0.05) stockLive[id] = 0;
      }
    }
    prevIds = new Set(ids);

    days.push({
      day: d, day_name: DAY_NAMES[d],
      items: result.items, totals: result.totals, ratios: result.ratios,
      adequacy: result.adequacy, cost: result.totals.cost,
      purchase_cost: round1(dayPurchase),
      stock_remaining: stockLive ? { ...stockLive } : null,
      feasible: result.feasible, reasons: result.reasons || [],
    });
  }

  const allIds = [];
  for (const day of days) for (const it of day.items) allIds.push(it.food_id);
  const unique = new Set(allIds);
  const counts = {};
  allIds.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  const repeats = allIds.length - unique.size;
  const proteinKindsUsed = new Set();
  for (const day of days) {
    for (const it of day.items) {
      const kind = PROTEIN_KINDS.find(k => k.ids.includes(it.food_id));
      if (kind && it.role === "protein") proteinKindsUsed.add(kind.kind);
    }
  }

  return {
    days,
    diversity: {
      unique_foods: unique.size,
      total_servings: allIds.length,
      repeat_servings: repeats,
      protein_kinds: proteinKindsUsed.size,
      protein_kinds_max: PROTEIN_KINDS.length,
      liver_count: (counts["pork_liver"] || 0),
    },
    weekly_cost: Math.round(days.reduce((s, d) => s + d.cost, 0) * 100) / 100,
    weekly_purchase_cost: round1(days.reduce((s, d) => s + d.purchase_cost, 0)),
    stock_remaining: stockLive ? { ...stockLive } : null,
    weekly_used: weeklyUsed,
    feasible: days.every(x => x.feasible),
  };
}

function round1(x) { return Math.round(x * 10) / 10; }

module.exports = { weekPlan, DAY_NAMES, STAPLE_ROTATION, PROTEIN_KINDS, buildDayPools };

"use strict";
/* 单日膳食多维约束求解：
   热量区间 / 宏量营养素供能比 / 微量营养素达标 / 预算上限 / 过敏原与限次约束。
   毛重计价与克重调整，营养素按可食部折算。 */

const { FOODS, getFood, nutrientsFor, costFor, NUTRIENT_ORDER } = require("./foods");
const { getRequirement } = require("./requirements");

const MEALS = ["breakfast", "lunch", "dinner"];
const MEAL_LABEL = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐" };

const K = { PROTEIN: 4, FAT: 9, CARB: 4 }; // 供能系数 kcal/g
const FAT_RATIO = [0.20, 0.30];
const PROTEIN_RATIO = [0.10, 0.20];
const CARB_RATIO = [0.50, 0.65];
const KCAL_TOL = 0.05;

/* 早餐模板：主食 + 蛋奶 + 水果 */
const BREAKFAST_SLOTS = [
  { role: "staple", pool: ["oatmeal", "millet", "whole_wheat_bread", "steamed_bun", "sweet_potato"], grams: 200 },
  { role: "dairy_egg", pool: ["egg", "milk_full", "yogurt", "soymilk"], grams: 120 },
  { role: "fruit", pool: ["apple", "banana", "orange", "pear", "kiwi"], grams: 150 },
];

/* 午/晚餐模板：主食 + 蛋白质主菜 + 蔬菜×2 + 油脂 */
const LUNCH_SLOTS = [
  { role: "staple", pool: ["rice_long", "brown_rice", "buckwheat", "spaghetti", "steamed_bun"], grams: 220 },
  { role: "protein", pool: ["chicken_breast", "pork_lean", "beef_tenderloin", "salmon", "bass", "shrimp", "tofu_north"], grams: 120 },
  { role: "veg_a", pool: ["broccoli", "spinach", "cabbage", "red_cabbage", "asparagus", "carrot"], grams: 110 },
  { role: "veg_b", pool: ["tomato", "cucumber", "green_pepper", "mushroom", "eggplant", "pumpkin"], grams: 110 },
  { role: "oil", pool: ["olive_oil", "sesame_oil", "linseed_oil"], grams: 6 },
];

const DINNER_SLOTS = [
  { role: "staple", pool: ["rice_round", "brown_rice", "sweet_potato", "corn", "potato"], grams: 180 },
  { role: "protein", pool: ["chicken_thigh", "beef_brisket", "lamb_lean", "cod", "scallop", "tofu_south", "yuba", "pork_liver"], grams: 100 },
  { role: "veg_a", pool: ["celery", "lettuce", "white_gourd", "pumpkin", "cabbage", "onion"], grams: 110 },
  { role: "veg_b", pool: ["cucumber", "tomato", "green_pepper", "carrot", "mushroom", "broccoli"], grams: 110 },
  { role: "oil", pool: ["olive_oil", "sesame_oil"], grams: 6 },
];

const SNACK_SLOT = { role: "nut", pool: ["peanut", "walnut", "almond"], grams: 10 };

const MIN_GRAMS = { staple: 60, dairy_egg: 40, protein: 40, veg_a: 40, veg_b: 40, oil: 2, fruit: 40, nut: 3 };

function kcalOf(n) { return K.PROTEIN * n.protein + K.FAT * n.fat + K.CARB * n.carb; }

function round1(x) { return Math.round(x * 10) / 10; }

function poolOf(slot, dayPools, meal) {
  if (!dayPools) return slot.pool;
  const keyMap = {
    breakfast_staple: "breakfast_staple",
    lunch_staple: "lunch_staple",
    dinner_staple: "dinner_staple",
    lunch_protein: "lunch_protein",
    dinner_protein: "dinner_protein",
    breakfast_dairy_egg: "dairy_egg",
    lunch_dairy_egg: "dairy_egg",
    dinner_dairy_egg: "dairy_egg",
    breakfast_fruit: "fruit",
    lunch_fruit: "fruit",
    dinner_fruit: "fruit",
    breakfast_nut: "nut",
    lunch_nut: "nut",
    dinner_nut: "nut",
    lunch_oil: "oil", dinner_oil: "oil", breakfast_oil: "oil",
    lunch_veg_a: "veg", lunch_veg_b: "veg",
    dinner_veg_a: "veg", dinner_veg_b: "veg",
  };
  const key = keyMap[meal + "_" + slot.role];
  if (key) {
    /* 家庭分餐成员替换：__force 指定该槽位只能落指定食材（成员替换的确定性求解） */
    if (dayPools.__force && dayPools.__force[key]) return dayPools.__force[key];
    if (dayPools[key]) return dayPools[key];
  }
  return slot.pool;
}

/* 各餐模板槽位表（家庭分餐按槽位求解替换候选使用） */
const SLOT_TABLE = {
  breakfast: BREAKFAST_SLOTS,
  lunch: LUNCH_SLOTS,
  dinner: DINNER_SLOTS,
  snack: [SNACK_SLOT],
};

function pick(slot, taken, excludeIds, dayPools, meal, params, stock) {
  const base = poolOf(slot, dayPools, meal);
  const pool = base.filter(id => !taken.has(id) && !excludeIds.has(id));
  if (pool.length === 0) return null;
  const first = getFood(pool[0]);
  /* 保持无库存时的历史语义：首选命中过敏原 / 周限次则放弃该槽位 */
  const allergenSet = new Set((params && params.allergens) || []);
  const weeklyUsed = (params && params.weekly_used) || {};
  const blocked = f => f.allergens.some(a => allergenSet.has(a))
    || (f.weekly_limit && (weeklyUsed[f.id] || 0) >= f.weekly_limit);
  if (blocked(first)) return null;
  /* 强制槽位（成员替换）：尊重替换意图，不再被库存优先逻辑改选 */
  const forceKeyMap = {
    breakfast_staple: "breakfast_staple", lunch_staple: "lunch_staple", dinner_staple: "dinner_staple",
    lunch_protein: "lunch_protein", dinner_protein: "dinner_protein",
    breakfast_dairy_egg: "dairy_egg", lunch_dairy_egg: "dairy_egg", dinner_dairy_egg: "dairy_egg",
    breakfast_fruit: "fruit", lunch_fruit: "fruit", dinner_fruit: "fruit",
    breakfast_nut: "nut", lunch_nut: "nut", dinner_nut: "nut",
    lunch_oil: "oil", dinner_oil: "oil", breakfast_oil: "oil",
    lunch_veg_a: "veg", lunch_veg_b: "veg", dinner_veg_a: "veg", dinner_veg_b: "veg",
  };
  const fKey = forceKeyMap[meal + "_" + slot.role];
  const forced = !!(dayPools && dayPools.__force && fKey && dayPools.__force[fKey]);
  if (forced) return first;
  /* 库存优先：在“可通过过滤”的候选中，把在库食材提为首选（无在库余量时保持池序） */
  if (stock) {
    const usable = pool.map(getFood).filter(f => f && !blocked(f));
    if (usable.some(f => (stock[f.id] || 0) > 0)) {
      usable.sort((a, b) => (stock[b.id] || 0) - (stock[a.id] || 0));
      return usable[0];
    }
  }
  return first;
}

function buildItems(params, req) {
  const excludeIds = new Set(params.exclude || []);
  const taken = new Set();
  const items = [];
  const weeklyUsed = params.weekly_used || {};
  const dayPools = params.day_pools || null;
  const stock = params.stock || null;

  const tryAdd = (slot, meal) => {
    const food = pick(slot, taken, excludeIds, dayPools, meal, params, stock);
    if (!food) return false;
    taken.add(food.id);
    items.push({ meal, role: slot.role, food_id: food.id, name: food.name, grams: slot.grams, pool: poolOf(slot, dayPools, meal) });
    return true;
  };

  BREAKFAST_SLOTS.forEach(s => tryAdd(s, "breakfast"));
  LUNCH_SLOTS.forEach(s => tryAdd(s, "lunch"));
  DINNER_SLOTS.forEach(s => tryAdd(s, "dinner"));
  tryAdd(SNACK_SLOT, "breakfast");

  /* 蛋白质主菜若全部被排除，退化为仅素食可食的组合 */
  const proteinCount = items.filter(i => i.role === "protein").length;
  if (proteinCount === 0) {
    const vegExtra = getFood("tofu_south");
    const allergenSet = new Set(params.allergens || []);
    if (vegExtra && !excludeIds.has(vegExtra.id) && !vegExtra.allergens.some(a => allergenSet.has(a))) {
      items.push({ meal: "lunch", role: "protein", food_id: vegExtra.id, name: vegExtra.name, grams: 120 });
    }
  }
  return items;
}

function totalOf(items) {
  const t = { cost: 0 };
  for (const k of NUTRIENT_ORDER) t[k] = 0;
  for (const it of items) {
    const f = getFood(it.food_id);
    const n = nutrientsFor(f, it.grams);
    for (const k of NUTRIENT_ORDER) t[k] += n[k];
    t.cost += costFor(f, it.grams);
  }
  return t;
}

/* 库存抵扣后的净采购核算：同一食材先在库内扣减，超出部分才需要采购。
   返回 purchase_cost（净采购额）与 remaining（方案消耗后的库存余量，毛重克）。 */
function purchaseState(items, stock) {
  const stock0 = stock || {};
  const used = {};
  let purchase = 0;
  for (const it of items) {
    const f = getFood(it.food_id);
    used[f.id] = (used[f.id] || 0) + it.grams;
  }
  const remaining = {};
  for (const [id, grams] of Object.entries(used)) {
    const have = stock0[id] || 0;
    const fromStock = Math.min(have, grams);
    const buy = grams - fromStock;
    remaining[id] = Math.max(0, have - grams);
    if (buy > 0) purchase += costFor(getFood(id), buy);
  }
  for (const [id, g] of Object.entries(stock0)) {
    if (used[id] == null) remaining[id] = g;
  }
  return { purchase_cost: round1(purchase), remaining };
}

function itemPurchaseCost(it, stock, stockLeft) {
  const f = getFood(it.food_id);
  const have = stockLeft ? (stockLeft[it.food_id] != null ? stockLeft[it.food_id] : (stock[it.food_id] || 0)) : 0;
  const fromStock = Math.min(have, it.grams);
  return costFor(f, it.grams - fromStock);
}

/* 单位有效采购成本（元/100g）：库存可覆盖的部分为 0，超出部分按库内单价 */
function effectiveUnitCost(f, stockGrams, grams) {
  const cover = Math.min(stockGrams || 0, grams);
  return f.cost * (grams - cover) / grams;
}

function ratios(t) {
  const kcal = t.kcal || 1;
  return {
    fat: (t.fat * K.FAT) / kcal,
    protein: (t.protein * K.PROTEIN) / kcal,
    carb: (t.carb * K.CARB) / kcal,
  };
}

function adjust(items, req, budget, params) {
  const foodOf = id => getFood(id);
  const excludeSet = new Set(params.exclude || []);
  const allergenSet = new Set(params.allergens || []);
  const stock = params.stock || null;
  const low = req.kcal * (1 - KCAL_TOL);
  const high = req.kcal * (1 + KCAL_TOL);

  /* 按 items 顺序分配库存，计算每项的边际采购成本（库存内为 0） */
  const marginalOf = () => {
    const left = {};
    if (stock) for (const k of Object.keys(stock)) left[k] = stock[k];
    return items.map(it => {
      const f = foodOf(it.food_id);
      const have = left[it.food_id] || 0;
      const cover = Math.min(have, it.grams);
      if (stock) left[it.food_id] = have - cover;
      return costFor(f, it.grams - cover);
    });
  };

  let changed = true;
  let iters = 0;
  while (changed && iters < 400) {
    changed = false;
    iters++;
    const t = totalOf(items);
    const kcal = t.kcal;
    const r = ratios(t);

    /* 1. 热量不足：按当前宏量短板分派加量目标，避免把已超界的宏量继续推高 */
    if (kcal < low) {
      const r2 = ratios(t);
      let pick = null;
      const inStock = it => !!(stock && (stock[it.food_id] || 0) > 0);
      /* 无库存时严格沿用历史排序，保证周菜单轮换确定性 */
      const byKcal = (arr) => stock
        ? arr.slice().sort((a, b) => Number(inStock(b)) - Number(inStock(a))
            || foodOf(b.food_id).per100g.kcal - foodOf(a.food_id).per100g.kcal)[0]
        : arr.slice().sort((a, b) => foodOf(b.food_id).per100g.kcal - foodOf(a.food_id).per100g.kcal)[0];
      const oilSorter = (a, b) => stock
        ? Number(inStock(b)) - Number(inStock(a)) || foodOf(b.food_id).per100g.fat - foodOf(a.food_id).per100g.fat
        : foodOf(b.food_id).per100g.fat - foodOf(a.food_id).per100g.fat;
      const oilPick = items.filter(i => i.role === "oil" && i.grams < 60).sort(oilSorter)[0];
      const nutPick = items.filter(i => i.role === "nut" && i.grams < 30).sort(oilSorter)[0];
      if (r2.fat < FAT_RATIO[0] + 0.02) {
        pick = oilPick || nutPick;
      }
      if (!pick && r2.carb > CARB_RATIO[1] - 0.02) {
        pick = oilPick || byKcal(items.filter(i => ["protein", "dairy_egg"].includes(i.role) && i.grams < 300));
      }
      if (!pick) {
        if (stock) {
          /* 库存模式：蛋白比接近上限时避免继续加高蛋白食材，在库食材优先 */
          let roles = ["staple", "fruit", "nut", "dairy_egg", "protein"];
          if (r2.protein > PROTEIN_RATIO[1] - 0.02) roles = ["staple", "fruit"];
          pick = byKcal(items.filter(i => roles.includes(i.role) && i.grams < (i.role === "nut" ? 30 : 750)));
        } else {
          pick = items.filter(i => ["staple", "fruit", "nut", "dairy_egg", "protein"].includes(i.role))
            .map(i => {
              const f = foodOf(i.food_id);
              const cap = i.role === "nut" ? 30 : 750;
              const pure = f.per100g.kcal - 0.35 * f.per100g.protein * K.PROTEIN - 1.2 * f.per100g.fat * K.FAT;
              return { it: i, s: pure / f.cost, cap };
            })
            .filter(x => x.it.grams < x.cap).sort((a, b) => b.s - a.s)[0];
          if (pick) pick = pick.it;
        }
      }
      if (pick) { pick.grams += 25; changed = true; }
      continue;
    }
    /* 2. 热量超标：先减能量密度最高者 */
    if (kcal > high) {
      const targets = items
        .filter(i => i.grams - 15 >= MIN_GRAMS[i.role])
        .sort((a, b) => foodOf(b.food_id).per100g.kcal - foodOf(a.food_id).per100g.kcal);
      if (targets.length) { targets[0].grams -= 15; changed = true; }
      continue;
    }
    /* 3. 蛋白质总量不足 */
    if (t.protein < req.protein) {
      const targets = items
        .filter(i => ["protein", "dairy_egg", "staple"].includes(i.role) && i.grams < 300)
        .sort((a, b) => foodOf(b.food_id).per100g.protein - foodOf(a.food_id).per100g.protein);
      if (targets.length) { targets[0].grams += 10; changed = true; }
      continue;
    }
    /* 4. 脂肪供能比超限：油脂无论是否在库都直接削减（免费不代表不占脂肪供能比），
          其次削花钱采购的高脂食材；无可削项再用在库主食稀释（不增加采购支出） */
    if (r.fat > FAT_RATIO[1]) {
      const oils = items.filter(i => i.role === "oil" && i.grams - 2 >= MIN_GRAMS[i.role])
        .sort((a, b) => foodOf(b.food_id).per100g.fat - foodOf(a.food_id).per100g.fat);
      if (oils.length) { oils[0].grams -= 2; changed = true; }
      else {
        const margin = marginalOf();
        const mcOf = it => margin[items.indexOf(it)] || 0;
        const inStock = it => stock && (stock[it.food_id] || 0) >= it.grams;
        const highFat = items
          .filter(i => i.role === "oil" || foodOf(i.food_id).per100g.fat >= 8)
          .filter(i => i.grams - 3 >= MIN_GRAMS[i.role])
          .sort((a, b) => (mcOf(b) > 0) - (mcOf(a) > 0) || foodOf(b.food_id).per100g.fat - foodOf(a.food_id).per100g.fat);
        if (highFat.length && (mcOf(highFat[0]) > 0 || !inStock(highFat[0]))) { highFat[0].grams -= 3; changed = true; }
        else {
          const staple = items.filter(i => i.role === "staple" && i.grams < 400)
            .sort((a, b) => Number(inStock(b)) - Number(inStock(a)));
          if (staple.length) { staple[0].grams += 25; changed = true; }
          else if (highFat.length) { highFat[0].grams -= 3; changed = true; }
        }
      }
      continue;
    }
    /* 5. 脂肪供能比过低 */
    if (r.fat < FAT_RATIO[0]) {
      const oil = items.filter(i => i.role === "oil" && i.grams < 25);
      if (oil.length) { oil[0].grams += 2; changed = true; }
      continue;
    }
    /* 6. 蛋白质供能比超限：减高蛋白食材 */
    if (r.protein > PROTEIN_RATIO[1]) {
      const highP = items
        .filter(i => i.role === "protein" || i.role === "dairy_egg")
        .filter(i => i.grams - 15 >= MIN_GRAMS[i.role])
        .sort((a, b) => foodOf(b.food_id).per100g.protein - foodOf(a.food_id).per100g.protein);
      if (highP.length) { highP[0].grams -= 15; changed = true; }
      continue;
    }
    /* 7. 碳水化合物供能比超限 */
    if (r.carb > CARB_RATIO[1]) {
      const staple = items
        .filter(i => i.role === "staple" && i.grams - 20 >= MIN_GRAMS[i.role])
        .sort((a, b) => foodOf(b.food_id).per100g.carb - foodOf(a.food_id).per100g.carb);
      if (staple.length) { staple[0].grams -= 20; changed = true; }
      continue;
    }
    /* 8. 碳水化合物供能比过低 */
    if (r.carb < CARB_RATIO[0]) {
      const staple = items.filter(i => i.role === "staple" && i.grams < 450);
      if (staple.length) { staple[0].grams += 25; changed = true; }
      continue;
    }
    /* 9. 预算超限：净采购最贵项优先替换（在库余量项边际成本为 0 不会被选中），
          优先替换为同类在库食材，其次更廉价食材，无替代再压缩克重 */
    if (budget != null && purchaseState(items, stock).purchase_cost > budget) {
      const used = new Set(items.map(i => i.food_id));
      const margin = marginalOf();
      const costly = items
        .map((it, idx) => ({ it, idx, mc: margin[idx] }))
        .filter(x => x.it.grams >= MIN_GRAMS[x.it.role] && x.mc > 0)
        .sort((a, b) => b.mc - a.mc);
      if (costly.length) {
        const x = costly[0];
        const f = foodOf(x.it.food_id);
        const alternates = FOODS.filter(c =>
          (!x.it.pool || x.it.pool.includes(c.id)) &&
          !used.has(c.id) &&
          !c.allergens.some(a => allergenSet.has(a)) &&
          !excludeSet.has(c.id) &&
          (!c.weekly_limit || (params.weekly_used || {})[c.id] < c.weekly_limit)
        ).map(c => ({
          c,
          eff: stock ? effectiveUnitCost(c, stock[c.id] || 0, x.it.grams) : c.cost,
          inStock: stock && (stock[c.id] || 0) > 0,
        }))
          .filter(o => o.eff < x.mc / (x.it.grams / 100))
          .sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.eff - b.eff || b.c.cost - a.c.cost);
        if (alternates.length) {
          const alt = alternates[0].c;
          used.delete(x.it.food_id);
          x.it.food_id = alt.id;
          x.it.name = alt.name;
          used.add(alt.id);
          changed = true;
        } else if (x.it.grams - 10 >= MIN_GRAMS[x.it.role]) {
          x.it.grams -= 10;
          changed = true;
        }
      }
      continue;
    }
  }
  return items;
}

function adequacyOf(totals, req) {
  const map = [
    ["kcal", totals.kcal, req.kcal],
    ["protein", totals.protein, req.protein],
    ["fiber", totals.fiber, req.fiber],
    ["calcium", totals.calcium, req.calcium],
    ["iron", totals.iron, req.iron],
    ["vitA", totals.vitA, req.vitA],
    ["vitC", totals.vitC, req.vitC],
    ["vitD", totals.vitD, req.vitD],
    ["potassium", totals.potassium, req.potassium],
  ];
  const out = {};
  for (const [k, v, target] of map) {
    out[k] = { value: round1(v), target, pct: Math.round((v / target) * 100) };
  }
  out.sodium = { value: round1(totals.sodium), max: req.sodium_max, pct: Math.round((totals.sodium / req.sodium_max) * 100) };
  return out;
}

function planDay(params) {
  const req = getRequirement(params.profile);
  const budget = params.budget == null ? null : Number(params.budget);
  const items = buildItems(params, req);

  const poolCount = FOODS.filter(f =>
    !f.allergens.some(a => params.allergens.includes(a)) &&
    !(params.exclude || []).includes(f.id)
  ).length;
  if (poolCount === 0) {
    return { feasible: false, reason: "可用食材为空：过敏原与排除项覆盖全部食材", items: [], totals: null, adequacy: null };
  }
  if (items.length < 10) {
    return { feasible: false, reason: "可用食材过少，无法构成完整三餐", items: [], totals: null, adequacy: null };
  }

  adjust(items, req, budget, params);

  const totals = totalOf(items);
  const r = ratios(totals);
  const stock = params.stock || null;
  const purchase = purchaseState(items, stock);
  const low = req.kcal * (1 - KCAL_TOL);
  const high = req.kcal * (1 + KCAL_TOL);
  const kcalOk = totals.kcal >= low && totals.kcal <= high;
  const fatOk = r.fat >= FAT_RATIO[0] && r.fat <= FAT_RATIO[1];
  const proteinOk = r.protein >= PROTEIN_RATIO[0] && r.protein <= PROTEIN_RATIO[1];
  /* 预算口径为库存抵扣后的净采购额，与家庭采购支出同步 */
  const budgetOk = budget == null || purchase.purchase_cost <= budget * 1.02;

  const output = {
    feasible: kcalOk && fatOk && proteinOk && budgetOk,
    reasons: [],
    items: items.map(it => {
      const f = getFood(it.food_id);
      return {
        meal: it.meal, meal_label: MEAL_LABEL[it.meal], role: it.role,
        food_id: it.food_id, name: it.name, grams: it.grams,
        cost: round1(costFor(f, it.grams)),
      };
    }),
    totals: roundTotals(totals),
    purchase_cost: purchase.purchase_cost,
    stock_used: stock ? round1(totals.cost - purchase.purchase_cost) : 0,
    stock_remaining: stock ? purchase.remaining : null,
    ratios: { fat: r.fat, protein: r.protein, carb: r.carb },
    adequacy: adequacyOf(totals, req),
  };
  if (!kcalOk) output.reasons.push("热量未落在目标区间");
  if (!fatOk) output.reasons.push("脂肪供能比偏离 20%-30% 区间");
  if (!proteinOk) output.reasons.push("蛋白质供能比偏离 10%-20% 区间");
  if (!budgetOk) output.reasons.push("净采购预算超限");
  return output;
}

function roundTotals(t) {
  const out = { cost: round1(t.cost) };
  for (const k of NUTRIENT_ORDER) out[k] = round1(t[k]);
  return out;
}

module.exports = { planDay, ratios, totalOf, purchaseState, adequacyOf, MEALS, MEAL_LABEL, K, SLOT_TABLE };

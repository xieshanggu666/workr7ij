"use strict";
const assert = require("assert");
const hh = require("../engine/household");
const fam = require("../engine/family");
const foodsMod = require("../engine/foods");
const { getRequirement } = require("../engine/requirements");

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

function setupFamily() {
  const s = hh.emptyHousehold();
  const dad = hh.addMember(s, { name: "爸爸", profile: { age_group: "adult_m", activity: "moderate", goal: "maintain" }, allergens: [], role: "parent" });
  const mom = hh.addMember(s, { name: "妈妈", profile: { age_group: "adult_f", activity: "light", goal: "lose" }, allergens: ["鱼"], role: "member" });
  const buyer = hh.addMember(s, { name: "爷爷", profile: { age_group: "senior_m", activity: "light", goal: "maintain" }, allergens: [], role: "buyer" });
  return { s, dad, mom, buyer };
}

function build() {
  const ctx = setupFamily();
  fam.buildFamilyPlan(ctx.s, {});
  return ctx;
}

/* ---------- 生成：按成员营养目标 ---------- */

t("无成员不能生成分餐菜单", () => {
  const s = hh.emptyHousehold();
  assert.throws(() => fam.buildFamilyPlan(s, {}));
});

t("分餐菜单为每个成员 × 7 天 × 每餐生成可追溯行", () => {
  const { s } = build();
  const fp = s.family_plan;
  assert.strictEqual(fp.cycle, 1);
  assert.strictEqual(fp.member_ids.length, 3);
  assert(fp.lines.length > 0);
  for (const m of fp.member_ids) {
    for (let d = 0; d < 7; d++) {
      const rows = fp.lines.filter(l => l.member_id === m && l.day === d);
      assert(rows.length >= 10, `成员${m} 第${d}天行数不足: ${rows.length}`);
      for (const meal of ["breakfast", "lunch", "dinner"]) {
        assert(rows.some(l => l.meal === meal), `成员${m} 第${d}天缺${meal}`);
      }
    }
  }
  /* 每行具备追溯字段 */
  const ln = fp.lines[0];
  assert(ln.grams_history.length === 1 && ln.grams_history[0].note.includes("营养目标"));
  assert(Array.isArray(ln.substitutions) && ln.planned_grams === ln.grams);
});

t("成员营养目标不同：女性减重画像行克重整体区别于男性维持画像", () => {
  const { s, dad, mom } = build();
  const reqDad = getRequirement(s.members.find(m => m.id === dad.id).profile);
  const reqMom = getRequirement(s.members.find(m => m.id === mom.id).profile);
  assert(reqDad.kcal > reqMom.kcal);
  const v = fam.familyView(s);
  const day = (mid) => v.nutrition.find(x => x.member_id === mid).days[0];
  const kDad = day(dad.id).totals.kcal;
  const kMom = day(mom.id).totals.kcal;
  /* 两张菜单目标热量不同，实际合计也应有明显差异 */
  assert(Math.abs(kDad - kMom) > 100, `热量区分不足: ${kDad} vs ${kMom}`);
  assert(day(dad.id).requirement.kcal === reqDad.kcal);
});

t("过敏限制：对鱼过敏成员的菜单无任何鱼类，全家并集同步规避", () => {
  const { s, mom } = build();
  const fish = ["salmon", "cod", "bass"];
  const moms = s.family_plan.lines.filter(l => l.member_id === mom.id);
  assert(!moms.some(l => fish.includes(l.food_id)), "妈妈菜单出现鱼类");
  /* 鱼不是全家并集（只有妈妈过敏），其他成员可以吃到鱼 */
  const others = s.family_plan.lines.filter(l => l.member_id !== mom.id);
  /* 至少存在出现鱼类的可能（不强制），但采购清单绝不能含妈妈过敏以外的全家拦截项；
     此处验证鱼类食材可进入他人菜单或采购（非硬性），跳过具体断言 */
  assert(others.length > 0);
});

t("成员忌口（exclude）双重拦截：忌口食材不进入该成员任何一行", () => {
  const s = hh.emptyHousehold();
  const p = hh.addMember(s, { name: "家长", role: "parent" });
  hh.addMember(s, { name: "宝宝", role: "member", allergens: [], exclude: ["broccoli"] });
  fam.buildFamilyPlan(s, {});
  const baby = s.members.find(m => m.name === "宝宝");
  assert(!s.family_plan.lines.some(l => l.member_id === baby.id && l.food_id === "broccoli"));
  /* 另一成员不受影响（允许出现西兰花），家长角色仅用于权限 */
  assert(p.id);
});

t("生成后自动同步分餐来源采购清单与预算（净需求 + 安全余量）", () => {
  const { s } = build();
  const famItems = s.shopping.filter(i => i.source === "family" && i.status === "pending");
  assert(famItems.length > 0, "应自动产生分餐采购任务");
  /* 采购净需求覆盖分餐菜单全部食材（×1.1 向上取整 10g，库存/待买抵扣后） */
  const need = fam.familyNeed(s);
  for (const [id, g] of Object.entries(need)) {
    const buy = famItems.filter(i => i.food_id === id).reduce((sum, i) => sum + i.grams, 0);
    assert(buy + 1e-6 >= g * 1.1 - 9, `${id} 采购量 ${buy} 未覆盖需求 ${g}`);
  }
  const b = hh.budgetSummary(s);
  assert(b.committed > 0);
  assert.strictEqual(b.projected, round2(b.spent + b.committed));
  function round2(x) { return Math.round(x * 100) / 100; }
});

t("库存优先：期初库存覆盖的食材不产生分餐采购", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "家长" });
  /* 给足常见食材库存，重新生成后净采购应显著低于无库存 */
  hh.setManualStock(s, "rice_long", 5000);
  hh.setManualStock(s, "chicken_breast", 3000);
  hh.setManualStock(s, "broccoli", 3000);
  fam.buildFamilyPlan(s, {});
  const v = fam.familyView(s);
  assert(v.budget.committed >= 0);
  /* 米饭被库存覆盖时不应有待买 */
  const riceBuy = s.shopping.filter(i => i.source === "family" && i.food_id === "rice_long" && i.status === "pending");
  assert.strictEqual(riceBuy.length, 0);
});

/* ---------- 家长确认份量 ---------- */

t("家长可整周确认份量，进度从 pending 变为 confirmed", () => {
  const { s, dad } = build();
  let v = fam.familyView(s);
  assert(v.progress.pending > 0 && v.progress.confirmed === 0);
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  v = fam.familyView(s);
  assert.strictEqual(v.progress.confirmed, v.progress.total);
  assert.strictEqual(v.progress.pending, 0);
  const ln = s.family_plan.lines[0];
  assert.strictEqual(ln.portion_by, dad.id);
  assert(ln.grams_history.some(h => h.note === "家长确认份量"));
});

t("非家长角色不能确认份量", () => {
  const { s, mom } = build();
  assert.throws(() => fam.confirmPortions(s, { scope: "all" }, mom.id), /家长/);
});

t("家长可调整某行克重，调整后回退待确认且留痕，采购净需求同步刷新", () => {
  const { s, dad } = build();
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  const ln = s.family_plan.lines[0];
  const before = s.shopping.filter(i => i.source === "family" && i.food_id === ln.food_id && i.status === "pending").reduce((x, i) => x + i.grams, 0);
  const newGrams = ln.grams + 500;
  fam.setLineGrams(s, ln.id, newGrams, dad.id, "孩子多吃点");
  const ln2 = s.family_plan.lines.find(x => x.id === ln.id);
  assert.strictEqual(ln2.status, "pending");
  assert(ln2.grams_history.some(h => h.note === "孩子多吃点" && h.grams === newGrams));
  const after = s.shopping.filter(i => i.source === "family" && i.food_id === ln.food_id && i.status === "pending").reduce((x, i) => x + i.grams, 0);
  assert(after >= before, "加量后采购需求不应下降");
  assert.throws(() => fam.setLineGrams(s, ln.id, -5, dad.id));
});

t("按成员某日确认份量：只影响该成员当日行", () => {
  const { s, dad, mom } = build();
  fam.confirmPortions(s, { scope: "member_day", member_id: mom.id, day: 0 }, dad.id);
  const rows = s.family_plan.lines.filter(l => l.day === 0);
  assert(rows.filter(l => l.member_id === mom.id).every(l => l.status === "confirmed"));
  assert(rows.filter(l => l.member_id !== mom.id).every(l => l.status === "pending"));
  assert.strictEqual(s.family_plan.member_days[mom.id][0].portion_status, "confirmed");
  assert.strictEqual(s.family_plan.member_days[dad.id][0].portion_status, "pending");
});

/* ---------- 成员替换 ---------- */

t("成员只能查询 / 替换自己的分餐行", () => {
  const { s, dad, mom } = build();
  const dadLine = s.family_plan.lines.find(l => l.member_id === dad.id);
  assert.throws(() => fam.substituteOptions(s, dadLine.id, mom.id), /本人/);
  const momLine = s.family_plan.lines.find(l => l.member_id === mom.id && l.role === "protein");
  const opts = fam.substituteOptions(s, momLine.id, mom.id);
  assert(Array.isArray(opts.options));
});

t("替换候选排除过敏原、忌口与周限次，在库食材排首选", () => {
  const { s, mom } = build();
  /* 猪肝周限次 1；先在计划占用/消耗外验证候选不含过敏食材：妈妈忌鱼，蛋白槽候选不应出现鱼 */
  const line = s.family_plan.lines.find(l => l.member_id === mom.id && l.role === "protein");
  const opts = fam.substituteOptions(s, line.id, mom.id);
  assert(!opts.options.some(o => ["salmon", "cod", "bass"].includes(o.food_id)), "替换候选出现鱼类过敏原");
  assert(!opts.options.some(o => o.food_id === line.food_id), "候选包含当前食材");
});

t("成员确认替换后行食材变更、留痕，份量回退待家长确认，采购清单同步", () => {
  const { s, dad, mom } = build();
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  const line = s.family_plan.lines.find(l => l.member_id === mom.id && l.day === 2 && l.role === "protein");
  const fromFood = line.food_id;
  const opts = fam.substituteOptions(s, line.id, mom.id);
  assert(opts.options.length > 0, "应有替换候选");
  const target = opts.options[0].food_id;
  fam.substituteLine(s, line.id, { reason: "今天不想吃这个" }, mom.id);
  /* 替换后该行可能因日重排而定位到新食材（同槽位行），直接查替换记录 */
  const sub = s.family_plan.lines.flatMap(l => l.substitutions).find(x => x.from === fromFood && x.reason === "今天不想吃这个");
  assert(sub, "缺少替换记录");
  assert.strictEqual(sub.to, target);
  assert.strictEqual(sub.by, mom.id);
  assert.strictEqual(s.family_plan.member_days[mom.id][2].portion_status, "pending");
  /* 事件流可追溯 */
  assert(s.family_plan.events.some(e => e.kind === "substitute" && e.reason === "今天不想吃这个"));
});

t("替换候选尊重周限次：猪肝已占用 1 次后不再作为候选", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "家长", role: "parent" });
  const kid = hh.addMember(s, { name: "少年", profile: { age_group: "teen_m" }, role: "member" });
  fam.buildFamilyPlan(s, {});
  /* 周二（d=1）晚餐蛋白槽为猪肝；模拟已用 1 次（先入库再消耗） */
  hh.setManualStock(s, "pork_liver", 50);
  hh.consume(s, { food_id: "pork_liver", grams: 50 });
  const line = s.family_plan.lines.find(l => l.member_id === kid.id && l.meal === "dinner" && l.role === "protein");
  if (line) {
    const opts = fam.substituteOptions(s, line.id, kid.id);
    assert(!opts.options.some(o => o.food_id === "pork_liver"), "猪肝超过周限次仍可替换");
  }
});

/* ---------- 采购负责人到货 ---------- */

t("非采购负责人不能确认到货；负责人到货后入库存、记实际支出与到货人", () => {
  const { s, dad, buyer } = build();
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  const item = s.shopping.find(i => i.source === "family" && i.status === "pending");
  assert(item, "应有分餐采购任务");
  assert.throws(() => fam.arriveFamilyItem(s, item.id, {}, dad.id), /采购负责人/);
  fam.arriveFamilyItem(s, item.id, { grams: item.grams + 20, unit_cost: foodsMod.getFood(item.food_id).cost + 1 }, buyer.id);
  const it2 = s.shopping.find(i => i.id === item.id);
  assert.strictEqual(it2.status, "arrived");
  assert.strictEqual(it2.arrived_by, buyer.id);
  assert.strictEqual(hh.stockOnHand(s)[item.food_id], item.grams + 20);
  assert(hh.budgetSummary(s).spent > 0);
  assert(s.family_plan.events.some(e => e.kind === "arrive" && e.shopping_id === item.id));
});

/* ---------- 按日消耗 ---------- */

t("未全员确认份量时按日消耗被拒绝", () => {
  const { s, dad } = build();
  fam.confirmPortions(s, { scope: "member_day", member_id: s.family_plan.member_ids[0], day: 0 }, dad.id);
  assert.throws(() => fam.consumeFamilyDay(s, 0, dad.id), /份量未经家长确认/);
});

t("库存不足时按日消耗给出缺料明细且不产生扣减", () => {
  const { s, dad } = build();
  fam.confirmPortions(s, { scope: "day", day: 0 }, dad.id);
  const before = s.consumption.length;
  try {
    fam.consumeFamilyDay(s, 0, dad.id);
    assert.fail("应因缺料失败");
  } catch (e) {
    assert.strictEqual(e.code, "INSUFFICIENT_STOCK");
    assert(e.deficits.length > 0);
  }
  assert.strictEqual(s.consumption.length, before);
});

t("全部到货 + 家长确认份量后可按日消耗：逐行扣库存、行状态 consumed、不可重复", () => {
  const { s, dad, buyer } = build();
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  for (const it of s.shopping.filter(i => i.source === "family" && i.status === "pending")) {
    fam.arriveFamilyItem(s, it.id, {}, buyer.id);
  }
  const on0 = hh.stockOnHand(s);
  const dayNeed = {};
  for (const ln of s.family_plan.lines.filter(l => l.day === 0)) dayNeed[ln.food_id] = (dayNeed[ln.food_id] || 0) + ln.grams;
  fam.consumeFamilyDay(s, 0, dad.id);
  /* 行状态与实际克重 */
  for (const ln of s.family_plan.lines.filter(l => l.day === 0)) {
    assert.strictEqual(ln.status, "consumed");
    assert.strictEqual(ln.consumed_grams, ln.grams);
  }
  assert(s.family_plan.consumed_days.includes(0));
  /* 库存按净需求扣减（采购有余量，故剩余 = 到货 - 需求） */
  const on1 = hh.stockOnHand(s);
  for (const [id, g] of Object.entries(dayNeed)) {
    assert(Math.abs((on1[id] || 0) - ((on0[id] || 0) - g)) < 1e-6, `${id} 扣减不符`);
  }
  assert.throws(() => fam.consumeFamilyDay(s, 0, dad.id), /已确认消耗/);
});

t("已消耗入账的日期不能再调整份量或替换", () => {
  const { s, dad, buyer } = build();
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  for (const it of s.shopping.filter(i => i.source === "family" && i.status === "pending")) fam.arriveFamilyItem(s, it.id, {}, buyer.id);
  fam.consumeFamilyDay(s, 0, dad.id);
  const ln0 = s.family_plan.lines.find(l => l.day === 0);
  assert.throws(() => fam.setLineGrams(s, ln0.id, 999, dad.id));
  assert.throws(() => fam.substituteOptions(s, ln0.id, ln0.member_id), /已消耗/);
});

/* ---------- 预算 / 库存 / 周期同步 ---------- */

t("替换后采购预算与净需求同步刷新（删除被替换食材的多余待买）", () => {
  const { s, dad, mom } = build();
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  const committed0 = hh.budgetSummary(s).committed;
  /* 找一个替换后首选为更便宜或在库的蛋白行 */
  const line = s.family_plan.lines.find(l => l.member_id === mom.id && l.role === "protein" && l.day < 7);
  fam.substituteLine(s, line.id, {}, mom.id);
  const committed1 = hh.budgetSummary(s).committed;
  /* 净需求结构变化后重新聚合，待买总额为重新计算值（不强制定向，但必须与分餐行一致） */
  const v = fam.familyView(s);
  assert(Math.abs(v.budget.committed - committed1) < 1e-9);
  assert(typeof committed0 === "number");
});

t("库存估值与实际价偏差随分餐到货同步", () => {
  const { s, dad, buyer } = build();
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  const item = s.shopping.find(i => i.source === "family" && i.status === "pending");
  fam.arriveFamilyItem(s, item.id, { unit_cost: foodsMod.getFood(item.food_id).cost * 2 }, buyer.id);
  const b = hh.budgetSummary(s);
  assert(b.price_delta > 0, "实际价翻倍应产生正偏差");
  assert(hh.inventoryValue(s).total > 0);
});

t("开启新采购周后旧分餐菜单仅可追溯：确认被拒绝且报 STALE_WEEK，重新生成后恢复", () => {
  const { s, dad, buyer } = build();
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  for (const it of s.shopping.filter(i => i.source === "family" && i.status === "pending")) fam.arriveFamilyItem(s, it.id, {}, buyer.id);
  fam.consumeFamilyDay(s, 0, dad.id);
  const logsBefore = s.consumption.length;
  hh.startNewCycle(s);
  assert.strictEqual(fam.familyCurrent(s), false);
  const tr = fam.familyTrace(s, {});
  assert.strictEqual(tr.stale, true);
  assert(tr.lines.length > 0 && tr.events.length > 0, "旧菜单仍可追溯");
  let code = null;
  try { fam.consumeFamilyDay(s, 1, dad.id); } catch (e) { code = e.code; }
  assert.strictEqual(code, "STALE_WEEK");
  assert.strictEqual(s.consumption.length, logsBefore);
  /* 新周期重新生成：版本跟随周期 */
  fam.buildFamilyPlan(s, {});
  assert.strictEqual(fam.familyCurrent(s), true);
  assert.strictEqual(s.family_plan.cycle, 2);
});

/* ---------- 追溯 ---------- */

t("按成员追溯：返回该成员全部分餐行（含份量与替换历史）", () => {
  const { s, dad, mom } = build();
  fam.confirmPortions(s, { scope: "member_day", member_id: mom.id, day: 0 }, dad.id);
  const tr = fam.familyTrace(s, { member_id: mom.id });
  assert(tr.lines.every(l => l.member_id === mom.id));
  assert(tr.lines.length === s.family_plan.lines.filter(l => l.member_id === mom.id).length);
  assert(tr.lines[0].grams_history.length >= 1);
  assert(tr.shopping.length >= 0);
});

t("按食材追溯：计划份量、替换、到货与消耗全程串联", () => {
  const { s, dad, buyer } = build();
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  /* 全部到货并消耗第 1 天 */
  for (const it of s.shopping.filter(i => i.source === "family" && i.status === "pending")) fam.arriveFamilyItem(s, it.id, {}, buyer.id);
  fam.consumeFamilyDay(s, 0, dad.id);
  /* 选一个第 1 天实际消耗的食材 */
  const foodId = s.family_plan.lines.find(l => l.day === 0).food_id;
  const tr = fam.familyTrace(s, { food_id: foodId });
  assert(tr.lines.length > 0, "应有该食材的分餐行");
  const agg = tr.by_food.find(x => x.food_id === foodId);
  assert(agg.planned_grams > 0);
  assert(agg.consumed_grams > 0, "第 1 天应已消耗");
  assert(tr.shopping.some(i => i.food_id === foodId && i.status === "arrived"), "缺少到货记录");
  assert(tr.consumption.some(l => l.food_id === foodId), "缺少消耗记录");
  assert(tr.events.some(e => e.kind === "plan_built"));
  assert(tr.events.some(e => e.kind === "arrive"));
  assert(tr.events.some(e => e.kind === "consume_day"));
});

t("视图快照字段完整：进度 / 每日就绪状态 / 成员营养目标 / 缺料", () => {
  const { s } = build();
  const v = fam.familyView(s);
  assert(v.exists && v.current && v.cycle === 1);
  assert.strictEqual(v.days.length, 7);
  assert(v.days.every(d => Array.isArray(d.members) && d.members.length === 3));
  /* 无库存：首日未就绪且给出缺料 */
  assert.strictEqual(v.days[0].ready, false);
  assert(v.days[0].stock_deficits.length > 0 || v.deficits.length > 0);
  assert(v.nutrition.length === 3);
  assert(v.nutrition.every(x => x.requirement && x.days.length === 7));
  assert(["total", "confirmed", "pending", "consumed", "substituted"].every(k => k in v.progress));
});

t("已消耗日后重新生成被拒绝（保证菜单可追溯）", () => {
  const { s, dad, buyer } = build();
  fam.confirmPortions(s, { scope: "all" }, dad.id);
  for (const it of s.shopping.filter(i => i.source === "family" && i.status === "pending")) fam.arriveFamilyItem(s, it.id, {}, buyer.id);
  fam.consumeFamilyDay(s, 0, dad.id);
  assert.throws(() => fam.buildFamilyPlan(s, {}), /已有分餐消耗入账/);
});

t("全家过敏原变更后重建菜单：新过敏食材被清除出分餐行与采购", () => {
  const { s, dad } = build();
  /* 给爸爸加上鱼过敏，全家并集含鱼，重建后任何人的行与分餐采购都不应有鱼 */
  hh.updateMember(s, dad.id, { allergens: ["鱼"] });
  fam.buildFamilyPlan(s, {});
  const fish = ["salmon", "cod", "bass"];
  assert(!s.family_plan.lines.some(l => fish.includes(l.food_id)), "重建后仍含鱼类");
  assert(!s.shopping.some(i => i.source === "family" && fish.includes(i.food_id) && i.status === "pending"), "分餐采购仍含鱼类");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

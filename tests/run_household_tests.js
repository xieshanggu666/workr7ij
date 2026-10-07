"use strict";
const assert = require("assert");
const hh = require("../engine/household");
const foodsMod = require("../engine/foods");
const { planDay, purchaseState } = require("../engine/constraints");
const { weekPlan } = require("../engine/menu");

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

/* ---------- 家庭成员与过敏原 ---------- */
t("空家庭状态字段完整", () => {
  const s = hh.emptyHousehold();
  assert.strictEqual(s.cycle_no, 1);
  assert.strictEqual(s.members.length, 0);
  assert.deepStrictEqual(hh.familyAllergens(s.members), []);
  assert.strictEqual(s.weekly_budget >= 0, true);
});

t("添加成员并自动编号", () => {
  const s = hh.emptyHousehold();
  const a = hh.addMember(s, { name: "爸爸", allergens: ["乳"] });
  const b = hh.addMember(s, { name: "妈妈", allergens: ["花生"] });
  assert.strictEqual(a.id, 1);
  assert.strictEqual(b.id, 2);
  assert.deepStrictEqual(hh.familyAllergens(s.members), ["乳", "花生"]);
});

t("成员重名 / 空名 / 非法过敏原被拒绝", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "爸爸" });
  assert.throws(() => hh.addMember(s, { name: "爸爸" }));
  assert.throws(() => hh.addMember(s, { name: "  " }));
  assert.throws(() => hh.addMember(s, { name: "宝宝", allergens: ["不存在的过敏原"] }));
});

t("删除成员后其采购任务变为未分配", () => {
  const s = hh.emptyHousehold();
  const m = hh.addMember(s, { name: "爸爸" });
  hh.addManualItem(s, { food_id: "apple", grams: 200, assignee: m.id });
  hh.removeMember(s, m.id);
  assert.strictEqual(s.members.length, 0);
  assert.strictEqual(s.shopping[0].assignee, null);
});

t("更新成员过敏原后全家并集变化", () => {
  const s = hh.emptyHousehold();
  const m = hh.addMember(s, { name: "爸爸", allergens: ["乳"] });
  assert.deepStrictEqual(hh.familyAllergens(s.members), ["乳"]);
  hh.updateMember(s, m.id, { allergens: ["鱼"] });
  assert.deepStrictEqual(hh.familyAllergens(s.members), ["鱼"]);
});

/* ---------- 采购清单按周菜单生成 ---------- */
function seededWeek() {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "爸爸", allergens: [] });
  hh.addMember(s, { name: "妈妈", allergens: [] });
  const w = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w);
  hh.buildShoppingList(s, w);
  return { s, w };
}

t("周菜单每种食材都有对应的采购任务", () => {
  const { s, w } = seededWeek();
  const need = new Set();
  for (const day of w.days) for (const it of day.items) need.add(it.food_id);
  const bought = new Set(s.shopping.filter(i => i.source === "menu").map(i => i.food_id));
  for (const id of need) assert(bought.has(id), "缺少采购任务: " + id);
});

t("采购克重为净需求加安全余量并按 10g 向上取整", () => {
  const s = hh.emptyHousehold();
  const w = { days: [{ items: [{ food_id: "apple", grams: 100 }] }] };
  hh.buildShoppingList(s, w);
  const it = s.shopping.find(i => i.food_id === "apple");
  /* 100 * 1.1 = 110 -> 向上取整 110g */
  assert.strictEqual(it.grams, 110);
  assert.strictEqual(it.est_cost, Math.round(foodsMod.getFood("apple").cost * 1.1 * 100) / 100);
});

t("采购任务在两位成员间按负载分工且确定性", () => {
  const { s } = seededWeek();
  const load = {};
  s.members.forEach(m => { load[m.id] = 0; });
  for (const it of s.shopping.filter(i => i.status === "pending")) load[it.assignee] += it.est_cost;
  const diff = Math.abs(load[1] - load[2]);
  assert(diff < Math.max(load[1], load[2]) * 0.35, "分工负载悬殊: " + JSON.stringify(load));
  const again = seededWeek();
  assert.deepStrictEqual(s.shopping.map(i => [i.food_id, i.assignee]), again.s.shopping.map(i => [i.food_id, i.assignee]));
});

t("全家过敏原食材不会进入菜单采购清单，手动添加也被拦截", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "宝宝", allergens: ["乳"] });
  const w = weekPlan({ profile: PROF, budget: 30, allergens: ["乳"], exclude: [] });
  hh.buildShoppingList(s, w);
  const MILK = ["milk_full", "yogurt", "cheese", "whole_wheat_bread"];
  assert(!s.shopping.some(i => MILK.includes(i.food_id)));
  assert.throws(() => hh.addManualItem(s, { food_id: "milk_full", grams: 200 }));
});

t("库存与待买自动抵扣净需求", () => {
  const s = hh.emptyHousehold();
  const f = foodsMod.getFood("apple");
  /* 在库 50g + 待买 50g，需求 100g（目标 110g），净需求 10g -> 取整 10g */
  hh.setManualStock(s, "apple", 50);
  hh.addManualItem(s, { food_id: "apple", grams: 50 });
  hh.buildShoppingList(s, { days: [{ items: [{ food_id: "apple", grams: 100 }] }] });
  /* 手动项保留 50g；菜单新增项为 10g */
  const menuItem = s.shopping.find(i => i.source === "menu" && i.food_id === "apple");
  assert(menuItem, "应补菜单采购项");
  assert.strictEqual(menuItem.grams, 10);
  assert(f);
});

t("库存完全覆盖需求时不生成采购任务", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "apple", 500);
  hh.buildShoppingList(s, { days: [{ items: [{ food_id: "apple", grams: 100 }] }] });
  assert(!s.shopping.some(i => i.food_id === "apple"));
});

t("重新生成清单会移除已从菜单消失的待买任务并保留手动项", () => {
  const s = hh.emptyHousehold();
  hh.buildShoppingList(s, { days: [{ items: [{ food_id: "apple", grams: 100 }] }] });
  hh.addManualItem(s, { food_id: "banana", grams: 100 });
  hh.buildShoppingList(s, { days: [{ items: [{ food_id: "carrot", grams: 100 }] }] });
  assert(!s.shopping.some(i => i.source === "menu" && i.food_id === "apple"));
  assert(s.shopping.some(i => i.source === "manual" && i.food_id === "banana"));
  assert(s.shopping.some(i => i.food_id === "carrot"));
});

/* ---------- 到货与库存 ---------- */
t("确认到货后入库存并计入实际支出", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "爸爸" });
  const it = hh.addManualItem(s, { food_id: "apple", grams: 200 });
  const arr = hh.arriveItem(s, it.id, {});
  assert.strictEqual(arr.status, "arrived");
  assert.strictEqual(arr.arrived_grams, 200);
  assert.strictEqual(hh.stockOnHand(s).apple, 200);
  const b = hh.budgetSummary(s);
  assert(b.spent > 0);
  assert.strictEqual(b.committed, 0);
  assert.strictEqual(b.projected, b.spent);
});

t("到货可登记实际克重与实际单价", () => {
  const s = hh.emptyHousehold();
  const it = hh.addManualItem(s, { food_id: "apple", grams: 200 });
  hh.arriveItem(s, it.id, { grams: 220, unit_cost: 2.0 });
  assert.strictEqual(hh.stockOnHand(s).apple, 220);
  assert.strictEqual(hh.budgetSummary(s).spent, 4.4);
});

t("重复到货与非法克重被拒绝", () => {
  const s = hh.emptyHousehold();
  const it = hh.addManualItem(s, { food_id: "apple", grams: 200 });
  hh.arriveItem(s, it.id, {});
  assert.throws(() => hh.arriveItem(s, it.id, {}));
  assert.throws(() => hh.addManualItem(s, { food_id: "apple", grams: 0 }));
});

t("到货含全家过敏原食材被拦截（历史待买任务仍受保护）", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "宝宝", allergens: ["乳"] });
  /* 直接构造一条含乳的历史待买任务，模拟过敏原规则变严后的脏数据 */
  s.shopping.push({
    id: s.next_item_id++, cycle: s.cycle_no, source: "manual",
    food_id: "milk_full", grams: 200, est_cost: 2.2, assignee: null,
    status: "pending", arrived_grams: 0, actual_cost: 0,
  });
  const bad = s.shopping[0];
  assert.throws(() => hh.arriveItem(s, bad.id, {}));
  assert.strictEqual(bad.status, "pending");
});

/* ---------- 消耗 ---------- */
t("手动消耗扣减库存且不可超扣", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "apple", 300);
  hh.consume(s, { food_id: "apple", grams: 120 });
  assert.strictEqual(hh.stockOnHand(s).apple, 180);
  assert.throws(() => hh.consume(s, { food_id: "apple", grams: 999 }));
});

t("按配餐消耗整天：库存足则扣减、重复日期被拒绝", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "爸爸" });
  const w = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w);
  /* 全部到货 */
  hh.buildShoppingList(s, w);
  for (const it of s.shopping.filter(i => i.status === "pending")) hh.arriveItem(s, it.id, {});
  const logs = hh.consumeDay(s, 0);
  assert(logs.length > 0);
  assert(s.consumed_days.includes(0));
  assert.throws(() => hh.consumeDay(s, 0));
  /* 库存按第 1 天需求减少 */
  const total0 = {};
  for (const it of w.days[0].items) total0[it.food_id] = (total0[it.food_id] || 0) + it.grams;
  for (const [id, g] of Object.entries(total0)) {
    const remain = hh.stockOnHand(s)[id] || 0;
    /* 采购有安全余量，消耗后剩余 = 采购量 - 当日需求 */
    assert(remain >= -1e-6, id + " 库存异常 " + remain);
  }
});

t("库存不足时按天消耗给出缺料明细且不产生部分扣减", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "爸爸" });
  const w = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w);
  const beforeLogs = s.consumption.length;
  try {
    hh.consumeDay(s, 0);
    assert.fail("应因缺料失败");
  } catch (e) {
    assert.strictEqual(e.code, "INSUFFICIENT_STOCK");
    assert(e.deficits.length > 0);
  }
  assert.strictEqual(s.consumption.length, beforeLogs);
});

/* ---------- 预算同步 ---------- */
t("预算汇总：已花 + 待买 = 预计总支出，超支正确识别", () => {
  const s = hh.emptyHousehold();
  s.weekly_budget = 10;
  const a = hh.addManualItem(s, { food_id: "apple", grams: 500 }); // 1.2*5 = 6
  hh.arriveItem(s, a.id, {});
  hh.addManualItem(s, { food_id: "beef_tenderloin", grams: 200 }); // 4.5*2 = 9
  const b = hh.budgetSummary(s);
  assert.strictEqual(b.spent, 6);
  assert.strictEqual(b.committed, 9);
  assert.strictEqual(b.projected, 15);
  assert.strictEqual(b.remaining, -5);
  assert.strictEqual(b.over, true);
});

t("实际价与预估偏差计入 price_delta", () => {
  const s = hh.emptyHousehold();
  const it = hh.addManualItem(s, { food_id: "apple", grams: 100 }); // 预估 1.2
  hh.arriveItem(s, it.id, { grams: 100, unit_cost: 2.4 });          // 实付 2.4
  const b = hh.budgetSummary(s);
  assert.strictEqual(b.price_delta, 1.2);
});

/* ---------- 后续配餐同步 ---------- */
t("syncInputs 输出过敏原并集、周限次计数与在库库存", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "爸爸", allergens: ["乳"] });
  hh.setManualStock(s, "apple", 300);
  hh.consume(s, { food_id: "apple", grams: 100 });
  hh.consume(s, { food_id: "apple", grams: 50 });
  const sync = hh.syncInputs(s);
  assert.deepStrictEqual(sync.allergens, ["乳"]);
  assert.strictEqual(sync.stock.apple, 150);
  assert.strictEqual(sync.weekly_used.apple, 2);
});

t("库存优先：单日配餐选择在库食材且净采购额低于菜单成本", () => {
  /* 给午餐槽位中的鸡胸肉大量库存，计划应优先选它 */
  const stock = { chicken_breast: 300, broccoli: 300, rice_long: 600, tomato: 300, olive_oil: 30 };
  const r = planDay({ profile: PROF, budget: 25, allergens: [], exclude: [], stock });
  assert.strictEqual(r.feasible, true, r.reasons.join(";"));
  assert(r.items.some(i => i.food_id === "chicken_breast"));
  assert(r.purchase_cost <= r.totals.cost);
  assert(r.purchase_cost < r.totals.cost, "库存应抵扣采购成本");
  /* 库存余量结转到结果 */
  assert(r.stock_remaining.rice_long >= 0);
});

t("净采购预算约束：库存内食材不占用预算，零库存时回退原口径", () => {
  /* 低预算 + 大量库存覆盖主菜主食，仍应可行 */
  const stock = { chicken_breast: 400, broccoli: 400, rice_long: 800, tomato: 400, olive_oil: 40, egg: 200, apple: 300, peanut: 40 };
  const r = planDay({ profile: PROF, budget: 6, allergens: [], exclude: [], stock });
  assert.strictEqual(r.feasible, true, r.reasons.join(";"));
  assert(r.purchase_cost <= 6 * 1.02);
  /* 无库存时 purchase_cost 等于菜单成本 */
  const r0 = planDay({ profile: PROF, budget: 25, allergens: [], exclude: [] });
  assert.strictEqual(r0.purchase_cost, r0.totals.cost);
});

t("purchaseState 同食材先扣库存、超出才计采购", () => {
  const items = [
    { food_id: "apple", grams: 100 },
    { food_id: "apple", grams: 150 },
    { food_id: "carrot", grams: 100 },
  ];
  const ps = purchaseState(items, { apple: 200 });
  /* 苹果买 50g、胡萝卜买 100g */
  const expectCost = foodsMod.getFood("apple").cost * 0.5 + foodsMod.getFood("carrot").cost * 1;
  assert(Math.abs(ps.purchase_cost - Math.round(expectCost * 10) / 10) < 1e-6);
  assert.strictEqual(ps.remaining.apple, 0);
  assert.strictEqual(ps.remaining.carrot, 0);
});

t("周菜单库存逐日结转：全部在库时净采购显著降低", () => {
  /* 先用无库存菜单得到需求，再构造足额库存重算 */
  const w0 = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  const need = {};
  for (const day of w0.days) for (const it of day.items) need[it.food_id] = (need[it.food_id] || 0) + it.grams;
  const stock = {};
  for (const [id, g] of Object.entries(need)) stock[id] = g; // 恰好覆盖
  const w1 = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [], stock });
  /* 库存覆盖会影响选择，但净采购不应高于计划成本且多数天为 0 附近 */
  assert(w1.weekly_purchase_cost <= w1.weekly_cost);
  assert(w1.weekly_purchase_cost < w1.weekly_cost * 0.5, "净采购 " + w1.weekly_purchase_cost + " / " + w1.weekly_cost);
});

t("周菜单接受外部 weekly_used：猪肝已用 1 次则不再出现", () => {
  const w = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [], weekly_used: { pork_liver: 1 } });
  assert(!w.days.some(d => d.items.some(i => i.food_id === "pork_liver")));
});

/* ---------- 周期与预警 ---------- */
t("开启新周期：待买任务结转、周限次清零、库存保留", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "apple", 300);
  hh.addManualItem(s, { food_id: "carrot", grams: 100 });
  hh.consume(s, { food_id: "apple", grams: 100 });
  hh.startNewCycle(s);
  assert.strictEqual(s.cycle_no, 2);
  assert.strictEqual(s.shopping[0].cycle, 2);
  assert.deepStrictEqual(hh.weeklyUsed(s), {});
  /* 上周期消耗仍扣减库存核算结果 */
  assert.strictEqual(hh.stockOnHand(s).apple, 200);
});

t("新周期后旧周菜单不可重复入账：库存不再扣减、新周限次不被污染", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "爸爸" });
  const w = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w);
  assert.strictEqual(s.week.cycle, 1);
  /* 充足库存，排除缺料拦截干扰 */
  const need = {};
  for (const day of w.days) for (const it of day.items) need[it.food_id] = (need[it.food_id] || 0) + it.grams;
  for (const [id, g] of Object.entries(need)) hh.setManualStock(s, id, g * 3);
  hh.consumeDay(s, 0);
  const stockBefore = hh.stockOnHand(s);
  const logsBefore = s.consumption.length;
  hh.startNewCycle(s);
  /* 旧周菜单仍保留（可追溯），但确认消耗被拒绝且报 STALE_WEEK */
  assert(s.week && s.week.plan);
  assert.strictEqual(hh.weekIsCurrent(s), false);
  let code = null;
  try { hh.consumeDay(s, 0); } catch (e) { code = e.code; }
  assert.strictEqual(code, "STALE_WEEK");
  /* 库存未再次扣减、消耗记录未新增、新周限次未被污染 */
  assert.deepStrictEqual(hh.stockOnHand(s), stockBefore);
  assert.strictEqual(s.consumption.length, logsBefore);
  assert.deepStrictEqual(hh.weeklyUsed(s), {});
  /* 旧周消耗记录保留原周期标签，可追溯 */
  assert(s.consumption.length > 0);
  assert(s.consumption.every(l => l.cycle === 1));
});

t("新周期重新生成本周菜单后可正常确认消耗并入账到新周期", () => {
  const s = hh.emptyHousehold();
  const w1 = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w1);
  const need = {};
  for (const day of w1.days) for (const it of day.items) need[it.food_id] = (need[it.food_id] || 0) + it.grams;
  for (const [id, g] of Object.entries(need)) hh.setManualStock(s, id, g * 5);
  hh.consumeDay(s, 0);
  hh.startNewCycle(s);
  /* 新周期生成新菜单：版本号跟随周期，确认消耗正常入账 */
  const w2 = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w2);
  assert.strictEqual(s.week.cycle, 2);
  assert.strictEqual(hh.weekIsCurrent(s), true);
  const logs = hh.consumeDay(s, 0);
  assert(logs.length > 0);
  assert(logs.every(l => l.cycle === 2));
  assert(Object.keys(hh.weeklyUsed(s)).length > 0);
  assert(s.consumption.some(l => l.cycle === 1), "旧周记录仍保留");
});

t("周期切换后缺料预警不再依据旧周菜单，视图标记菜单过期", () => {
  const s = hh.emptyHousehold();
  const w = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w);
  /* 无库存无采购 -> 当前周期有缺料预警，且菜单未过期 */
  assert(hh.warnings(s).some(x => x.code === "shortage"));
  let v = hh.householdView(s);
  assert.strictEqual(v.week_stale, false);
  assert.strictEqual(v.week_cycle, 1);
  hh.startNewCycle(s);
  /* 旧周菜单不再驱动新周期缺料预警，视图标记过期 */
  assert(!hh.warnings(s).some(x => x.code === "shortage"));
  v = hh.householdView(s);
  assert.strictEqual(v.week_stale, true);
  assert.strictEqual(v.week_cycle, 1);
});

t("预警：在库含全家过敏原 / 超预算 / 后续缺料", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "宝宝", allergens: ["乳"] });
  hh.setManualStock(s, "milk_full", 200);
  s.weekly_budget = 5;
  hh.addManualItem(s, { food_id: "beef_tenderloin", grams: 500 });
  const w = weekPlan({ profile: PROF, budget: 30, allergens: ["乳"], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w);
  /* 不生成采购任务 -> 全部食材缺料预警 */
  const codes = hh.warnings(s).map(x => x.code);
  assert(codes.includes("allergen_stock"));
  assert(codes.includes("budget_over"));
  assert(codes.includes("shortage"));
});

t("无风险时预警为空且视图快照字段完整", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "爸爸" });
  const v = hh.householdView(s);
  assert.strictEqual(v.warnings.length, 0);
  assert(Array.isArray(v.shopping) && Array.isArray(v.stock));
  assert(typeof v.budget.projected === "number");
  assert(v.sync && v.sync.allergens);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

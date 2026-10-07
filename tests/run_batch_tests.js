"use strict";
const assert = require("assert");
const hh = require("../engine/household");
const family = require("../engine/family");
const foodsMod = require("../engine/foods");
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
const T = "2026-10-07";        // 固定“今天”，批次测试全程确定性
const PAST = "2020-01-01";     // 必然已过期
const FUTURE = "2099-01-01";   // 必然未过期

function arrivedBatchState(foodId, grams, arriveOpts) {
  const s = hh.emptyHousehold();
  const it = hh.addManualItem(s, { food_id: foodId, grams });
  hh.arriveItem(s, it.id, Object.assign({ today: T }, arriveOpts || {}));
  return s;
}

/* ---------- 批次登记（采购负责人） ---------- */
t("到货自动登记批次：默认保质期 = 类目保质天数，单价记实际到货价", () => {
  const s = arrivedBatchState("pork_lean", 200, { unit_cost: 3.5, arrived_by: null });
  assert.strictEqual(s.batches.length, 1);
  const b = s.batches[0];
  assert.strictEqual(b.food_id, "pork_lean");
  assert.strictEqual(b.grams, 200);
  assert.strictEqual(b.remaining, 200);
  assert.strictEqual(b.source, "arrival");
  assert.strictEqual(b.expiry_on, "2026-10-09"); // 肉蛋类默认 2 天
  assert.strictEqual(b.unit_cost, 3.5);
  assert.strictEqual(s.shopping[0].batch_id, b.id);
});

t("到货可用生产日期推算或显式指定保质期", () => {
  const s1 = arrivedBatchState("pork_lean", 200, { produced_on: "2026-10-01" });
  assert.strictEqual(s1.batches[0].expiry_on, "2026-10-03"); // 生产日期 + 2 天
  const s2 = arrivedBatchState("apple", 200, { expiry_on: "2026-10-15", produced_on: "2026-10-01" });
  assert.strictEqual(s2.batches[0].expiry_on, "2026-10-15"); // 显式保质期优先
  assert.strictEqual(s2.batches[0].produced_on, "2026-10-01");
  assert.throws(() => arrivedBatchState("apple", 200, { expiry_on: "10月15日" }));
});

t("手动登记批次：针对在库未批次化库存，超量与非法输入被拒绝", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "apple", 300);
  const b = hh.registerBatch(s, { food_id: "apple", grams: 200, expiry_on: "2026-10-12", today: T });
  assert.strictEqual(b.remaining, 200);
  assert.strictEqual(b.source, "manual");
  assert.throws(() => hh.registerBatch(s, { food_id: "apple", grams: 200, today: T }), /可登记批次的库存不足/); // 仅剩 100g 未批次化
  hh.registerBatch(s, { food_id: "apple", grams: 100, today: T }); // 默认保质期 = 今天 + 水果 5 天
  assert.strictEqual(s.batches[1].expiry_on, "2026-10-12");
  assert.throws(() => hh.registerBatch(s, { food_id: "apple", grams: 0, today: T }));
  assert.throws(() => hh.registerBatch(s, { food_id: "nope", grams: 10, today: T }));
});

t("登记批次角色校验：仅采购负责人，未分工或系统调用放行", () => {
  const s = hh.emptyHousehold();
  const buyer = hh.addMember(s, { name: "采购", role: "buyer" });
  const parent = hh.addMember(s, { name: "家长", role: "parent" });
  hh.setManualStock(s, "apple", 500);
  assert.throws(() => hh.registerBatch(s, { food_id: "apple", grams: 100, today: T }, parent.id), /仅采购负责人/);
  const b = hh.registerBatch(s, { food_id: "apple", grams: 100, today: T }, buyer.id);
  assert.strictEqual(b.registered_by, buyer.id);
  hh.registerBatch(s, { food_id: "apple", grams: 100, today: T }); // 系统调用放行
  assert.strictEqual(s.batches.length, 2);
});

t("盘库增量附带保质期自动登记批次；盘库下调按到期先后冲减批次余量", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "apple", 300, { expiry_on: "2026-10-20", today: T });
  assert.strictEqual(s.batches.length, 1);
  assert.strictEqual(s.batches[0].remaining, 300);
  hh.setManualStock(s, "apple", 100, { today: T }); // 下调 200g：批次合计冲减到与在库一致
  assert.strictEqual(s.batches[0].remaining, 100);
  assert.strictEqual(hh.stockOnHand(s).apple, 100);
});

/* ---------- FEFO 消耗与失效避让 ---------- */
t("消耗按 FEFO 扣减：先到期批次先出账", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "apple", 100, { expiry_on: "2026-10-20", today: T });
  hh.setManualStock(s, "apple", 250, { expiry_on: "2026-10-10", today: T }); // 增量 150g，更早到期
  hh.consume(s, { food_id: "apple", grams: 120, today: T });
  const [late, early] = s.batches;
  assert.strictEqual(early.remaining, 30);  // 10-10 到期批次先扣
  assert.strictEqual(late.remaining, 100);  // 10-20 到期批次未动
  assert.strictEqual(hh.stockOnHand(s).apple, 130);
});

t("已过期批次不参与消耗扣减，剩余量保持待报废", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "apple", 100, { expiry_on: PAST, today: T });
  hh.setManualStock(s, "apple", 200, { expiry_on: FUTURE, today: T });
  hh.consume(s, { food_id: "apple", grams: 50, today: T });
  const [expired, fresh] = s.batches;
  assert.strictEqual(expired.remaining, 100);
  assert.strictEqual(fresh.remaining, 50);
});

t("可用库存排除失效批次：在库不变、配餐输入自动避开", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "apple", 100, { expiry_on: PAST, today: T });
  hh.setManualStock(s, "apple", 250, { expiry_on: FUTURE, today: T }); // 增量 150g 正常
  assert.strictEqual(hh.stockOnHand(s).apple, 250);
  assert.strictEqual(hh.expiredStock(s, T).apple, 100);
  assert.strictEqual(hh.usableStock(s, T).apple, 150);
  const sync = hh.syncInputs(s, T);
  assert.strictEqual(sync.stock.apple, 150); // 配餐只见可用部分
});

t("消耗超出可用库存报错并提示失效待报废量", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "apple", 100, { expiry_on: PAST, today: T });
  let err = null;
  try { hh.consume(s, { food_id: "apple", grams: 50, today: T }); } catch (e) { err = e; }
  assert(err, "应报库存不足");
  assert.strictEqual(err.code, "INSUFFICIENT_STOCK");
  assert(/已失效 100g/.test(err.message));
  assert.strictEqual(err.deficit.expired, 100);
});

t("按天配餐消耗：失效库存不算可用，给出缺料明细", () => {
  const s = hh.emptyHousehold();
  const w = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w);
  const day0 = {};
  for (const it of w.days[0].items) day0[it.food_id] = (day0[it.food_id] || 0) + it.grams;
  const badFood = Object.keys(day0)[0];
  for (const [id, g] of Object.entries(day0)) {
    hh.setManualStock(s, id, Math.ceil(g), { expiry_on: id === badFood ? PAST : FUTURE, today: T });
  }
  let err = null;
  try { hh.consumeDay(s, 0, T); } catch (e) { err = e; }
  assert(err, "失效库存不应算可用");
  assert.strictEqual(err.code, "INSUFFICIENT_STOCK");
  assert(err.deficits.some(d => d.food_id === badFood));
  assert.strictEqual(s.consumption.length, 0);
});

/* ---------- 临期 / 过期判定与预警 ---------- */
t("批次状态边界：当天到期与 2 天内为临期，昨天起为已过期", () => {
  const mk = expiry => ({ status: "active", remaining: 10, expiry_on: expiry });
  assert.strictEqual(hh.batchStatus(mk("2026-10-07"), T), "near"); // 当天到期
  assert.strictEqual(hh.batchStatus(mk("2026-10-09"), T), "near"); // 2 天后
  assert.strictEqual(hh.batchStatus(mk("2026-10-10"), T), "fresh");
  assert.strictEqual(hh.batchStatus(mk("2026-10-06"), T), "expired");
  assert.strictEqual(hh.batchStatus(mk(null), T), "fresh"); // 未登记保质期不过期
  assert.strictEqual(hh.batchStatus({ status: "disposed", remaining: 0 }, T), "disposed");
});

t("临期批次预警，家长审核留用后预警消除", () => {
  const s = hh.emptyHousehold();
  const parent = hh.addMember(s, { name: "家长", role: "parent" });
  hh.setManualStock(s, "apple", 100, { expiry_on: "2026-10-08", today: T });
  let codes = hh.warnings(s, null, T).map(w => w.code);
  assert(codes.includes("batch_near"));
  const b = s.batches[0];
  hh.reviewBatch(s, b.id, parent.id, T);
  assert.strictEqual(b.reviewed_by, parent.id);
  codes = hh.warnings(s, null, T).map(w => w.code);
  assert(!codes.includes("batch_near"));
});

t("审核权限与状态约束：非家长拒绝、未临期拒绝、过期必须报废", () => {
  const s = hh.emptyHousehold();
  const member = hh.addMember(s, { name: "孩子", role: "member" });
  const parent = hh.addMember(s, { name: "家长", role: "parent" });
  hh.setManualStock(s, "apple", 100, { expiry_on: "2026-10-08", today: T });
  hh.setManualStock(s, "banana", 100, { expiry_on: FUTURE, today: T });
  hh.setManualStock(s, "pear", 100, { expiry_on: PAST, today: T });
  const [near, fresh, expired] = s.batches;
  assert.throws(() => hh.reviewBatch(s, near.id, member.id, T), /仅家长/);
  assert.throws(() => hh.reviewBatch(s, fresh.id, parent.id, T), /未临期/);
  assert.throws(() => hh.reviewBatch(s, expired.id, parent.id, T), /报废/);
  hh.reviewBatch(s, near.id, parent.id, T);
  assert(near.reviewed_ts > 0);
});

t("过期批次预警为危险级且配餐自动避开", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "milk_full", 200, { expiry_on: PAST, today: T });
  const ws = hh.warnings(s, null, T);
  const w = ws.find(x => x.code === "batch_expired");
  assert(w, "应有过期预警");
  assert.strictEqual(w.level, "danger");
  assert(/自动避开/.test(w.text));
});

/* ---------- 家长报废：同步库存、预算与替换采购 ---------- */
t("报废批次：批次清零、库存扣减、报废记录与损失入账", () => {
  const s = arrivedBatchState("apple", 200, { unit_cost: 1.5 }); // 200g @1.5 -> 损失 3.0
  const parent = hh.addMember(s, { name: "家长", role: "parent" });
  const b = s.batches[0];
  const valueBefore = hh.inventoryValue(s).total;
  const r = hh.disposeBatch(s, b.id, { actor_id: parent.id, reason: "变质报废", today: T });
  assert.strictEqual(b.status, "disposed");
  assert.strictEqual(b.remaining, 0);
  assert.strictEqual(hh.stockOnHand(s).apple || 0, 0);
  assert.strictEqual(r.disposal.grams, 200);
  assert.strictEqual(r.disposal.value_loss, 3);
  assert.strictEqual(r.disposal.reason, "变质报废");
  assert.strictEqual(r.disposal.by, parent.id);
  assert.strictEqual(s.disposals.length, 1);
  assert(hh.inventoryValue(s).total < valueBefore);
});

t("报废同步预算：报废损失列示、替换采购计入待买占用", () => {
  const s = arrivedBatchState("apple", 95, {}); // 报废 95g -> 替换 100g（10g 取整）
  hh.addMember(s, { name: "爸爸" });
  hh.addMember(s, { name: "妈妈" });
  const r = hh.disposeBatch(s, s.batches[0].id, { today: T });
  const rep = r.replacement;
  assert(rep, "应生成替换采购项");
  assert.strictEqual(rep.source, "replace");
  assert.strictEqual(rep.grams, 100);
  assert.strictEqual(rep.est_cost, Math.round(foodsMod.getFood("apple").cost * 100) / 100);
  assert.strictEqual(rep.assignee, 1); // 负载相同取 id 最小
  assert.strictEqual(rep.ref_batch_id, s.batches[0].id);
  const b = hh.budgetSummary(s);
  assert.strictEqual(b.waste_loss, r.disposal.value_loss);
  assert.strictEqual(b.waste_grams, 95);
  assert(b.committed >= rep.est_cost);
});

t("报废权限：仅家长可报废，重复报废被拒绝", () => {
  const s = arrivedBatchState("apple", 100, {});
  const member = hh.addMember(s, { name: "孩子", role: "member" });
  const parent = hh.addMember(s, { name: "家长", role: "parent" });
  const bid = s.batches[0].id;
  assert.throws(() => hh.disposeBatch(s, bid, { actor_id: member.id, today: T }), /仅家长/);
  hh.disposeBatch(s, bid, { actor_id: parent.id, today: T });
  assert.throws(() => hh.disposeBatch(s, bid, { actor_id: parent.id, today: T }), /已报废/);
});

t("含全家过敏原的批次报废不生成替换采购项", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "宝宝", allergens: ["乳"] });
  hh.setManualStock(s, "milk_full", 200, { expiry_on: PAST, today: T }); // 盘库允许录入但预警
  const r = hh.disposeBatch(s, s.batches[0].id, { today: T });
  assert.strictEqual(r.replacement, null);
  assert(!s.shopping.some(i => i.food_id === "milk_full"));
  assert.strictEqual(hh.stockOnHand(s).milk_full || 0, 0);
});

t("替换采购项计入待买抵扣：重建菜单清单不会重复采购", () => {
  const s = arrivedBatchState("apple", 100, {});
  hh.disposeBatch(s, s.batches[0].id, { today: T }); // 替换项 100g 待买
  hh.buildShoppingList(s, { days: [{ items: [{ food_id: "apple", grams: 100 }] }] }, { today: T });
  const menuItem = s.shopping.find(i => i.source === "menu" && i.food_id === "apple");
  /* 需求目标 110g，替换项待买 100g 抵扣后只需补 10g */
  assert.strictEqual(menuItem.grams, 10);
});

/* ---------- 周期与视图 ---------- */
t("开启新周期：批次与报废记录保留追溯，报废损失只计当前周期", () => {
  const s = arrivedBatchState("apple", 100, {});
  hh.disposeBatch(s, s.batches[0].id, { today: T });
  hh.setManualStock(s, "banana", 100, { expiry_on: FUTURE, today: T });
  assert(hh.budgetSummary(s).waste_loss > 0);
  hh.startNewCycle(s);
  assert.strictEqual(s.cycle_no, 2);
  assert.strictEqual(s.batches.length, 2);
  assert.strictEqual(s.disposals.length, 1);
  assert.strictEqual(hh.budgetSummary(s).waste_loss, 0); // 上周期损失不计入新周期
  assert.strictEqual(hh.stockOnHand(s).banana, 100);     // 库存与批次照常结转
});

t("视图快照：批次排序（过期优先）、库存行可用 / 失效拆分、报废列表", () => {
  const s = hh.emptyHousehold();
  hh.setManualStock(s, "apple", 100, { expiry_on: PAST, today: T });
  hh.setManualStock(s, "banana", 100, { expiry_on: "2026-10-08", today: T });
  hh.setManualStock(s, "pear", 100, { expiry_on: FUTURE, today: T });
  const v = hh.householdView(s, T);
  assert.strictEqual(v.batches[0].freshness, "expired");
  assert.strictEqual(v.batches[1].freshness, "near");
  assert.strictEqual(v.batches[2].freshness, "fresh");
  const appleRow = v.stock.find(x => x.food_id === "apple");
  assert.strictEqual(appleRow.usable_grams, 0);
  assert.strictEqual(appleRow.expired_grams, 100);
  assert(v.warnings.some(w => w.code === "batch_expired"));
  assert(v.warnings.some(w => w.code === "batch_near"));
  assert(Array.isArray(v.disposals));
  assert.strictEqual(v.sync.stock.apple, 0);
});

t("分餐协作按日消耗校验同样避开失效库存", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "爸爸", role: "parent" });
  family.buildFamilyPlan(s, {});
  const need0 = {};
  for (const l of s.family_plan.lines.filter(l => l.day === 0 && l.status !== "dropped")) {
    need0[l.food_id] = (need0[l.food_id] || 0) + l.grams;
  }
  for (const [id, g] of Object.entries(need0)) {
    hh.setManualStock(s, id, Math.ceil(g), { expiry_on: FUTURE, today: T });
  }
  assert.deepStrictEqual(family.familyStockDeficits(s, 0), []);
  /* 全部批次过期后：库存仍在但不可用，按日消耗校验给出缺料 */
  for (const b of s.batches) b.expiry_on = PAST;
  const defs = family.familyStockDeficits(s, 0);
  assert(defs.length > 0);
  assert(defs.some(d => d.food_id === s.family_plan.lines[0].food_id));
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

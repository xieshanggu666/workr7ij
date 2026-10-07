"use strict";
const assert = require("assert");
const hh = require("../engine/household");
const batches = require("../engine/batches");
const fam = require("../engine/family");
const foodsMod = require("../engine/foods");
const { planDay } = require("../engine/constraints");
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
const APPLE = "apple";

function setupFamily() {
  const s = hh.emptyHousehold();
  const parent = hh.addMember(s, { name: "爸爸", role: "parent" });
  const buyer = hh.addMember(s, { name: "妈妈", role: "buyer" });
  const kid = hh.addMember(s, { name: "宝宝", role: "member" });
  hh.setClock(s, "2026-10-07", 3);
  return { s, parent, buyer, kid };
}

/* ---------- 业务日期与状态判定 ---------- */

t("业务日期缺省取系统当天，可固定与恢复", () => {
  const s = hh.emptyHousehold();
  const r = hh.setClock(s, "2026-10-07", 3);
  assert.strictEqual(r.today, "2026-10-07");
  assert.strictEqual(r.near_days, 3);
  assert.strictEqual(batches.businessDate(s), "2026-10-07");
  hh.setClock(s, null, 5);
  assert.strictEqual(batches.businessDate(s), batches.todayStr());
  assert.strictEqual(batches.nearDaysOf(s), 5);
  assert.throws(() => hh.setClock(s, "2026-10-xx"));
});

t("到期日由生产日期 + 保质期天数推导，非法日期被拒绝", () => {
  const s = hh.emptyHousehold();
  hh.setClock(s, "2026-10-07");
  const b = batches.registerBatch(s, { food_id: APPLE, grams: 100, produced_date: "2026-10-01", shelf_days: 10 });
  assert.strictEqual(b.expire_date, "2026-10-11");
  assert.strictEqual(batches.batchStatus(b, "2026-10-07", 3).key, "active");
  assert.throws(() => batches.registerBatch(s, { food_id: APPLE, grams: 100, expire_date: "2026-09-01", produced_date: "2026-10-01" }));
  assert.throws(() => batches.registerBatch(s, { food_id: APPLE, grams: 0 }));
  assert.throws(() => batches.registerBatch(s, { food_id: "unknown", grams: 10 }));
});

/* ---------- 批次登记与库存口径 ---------- */

t("到货自动生成批次：物理在库含全部，可用库存剔除过期 / 报废", () => {
  const { s, buyer } = setupFamily();
  const it = hh.addManualItem(s, { food_id: APPLE, grams: 200, assignee: buyer.id });
  hh.arriveItem(s, it.id, { produced_date: "2026-10-01", shelf_days: 10 }, buyer.id);
  assert.strictEqual(s.batches.length, 1);
  assert.strictEqual(hh.stockOnHand(s).apple, 200);
  assert.strictEqual(hh.usableStock(s).apple, 200);
  /* 推进到到期后 */
  hh.setClock(s, "2026-10-12");
  assert.strictEqual(hh.stockOnHand(s).apple, 200, "过期仍物理在库");
  assert.strictEqual(hh.usableStock(s).apple || 0, 0, "过期不可用");
});

t("无到期日批次长期有效（油 / 干货），不计临期过期", () => {
  const { s } = setupFamily();
  batches.registerBatch(s, { food_id: "olive_oil", grams: 100 });
  hh.setClock(s, "2030-01-01");
  assert.strictEqual(hh.usableStock(s).olive_oil, 100);
  assert.strictEqual(s.batches[0].expire_date, null);
});

t("非采购负责人不能到货登记批次；非家长不能审核报废", () => {
  const { s, parent, kid } = setupFamily();
  const it = hh.addManualItem(s, { food_id: APPLE, grams: 100 });
  assert.throws(() => hh.arriveItem(s, it.id, {}, parent.id), /采购负责人/);
  hh.arriveItem(s, it.id, { expire_date: "2026-10-08" }, null);
  const b = s.batches[0];
  assert.throws(() => hh.reviewScrapBatch(s, b.id, {}, kid.id), /家长/);
  assert.throws(() => hh.keepBatch(s, b.id, kid.id), /家长/);
});

/* ---------- 临期与过期预警 ---------- */

t("临期批次预警，家长确认继续使用后预警消失；过期转为 danger 并自动移出可用", () => {
  const { s, parent } = setupFamily();
  batches.registerBatch(s, { food_id: APPLE, grams: 100, expire_date: "2026-10-09" }); // 2 天后到期
  let codes = hh.warnings(s).map(w => w.code);
  assert(codes.includes("batch_near"), "应有临期预警");
  assert.strictEqual(hh.usableStock(s).apple, 100, "临期仍可用");
  hh.keepBatch(s, s.batches[0].id, parent.id, "尽快吃完");
  assert(!hh.warnings(s).some(w => w.code === "batch_near"), "确认后临期预警消失");
  /* 推进至过期 */
  hh.setClock(s, "2026-10-10");
  codes = hh.warnings(s).map(w => w.code);
  assert(codes.includes("batch_expired"));
  assert.strictEqual(hh.usableStock(s).apple || 0, 0);
  assert.throws(() => hh.keepBatch(s, s.batches[0].id, parent.id), /已过期/);
});

/* ---------- FEFO 消耗 ---------- */

t("消耗按 FEFO 先到期先消耗（临期优先），并逐批次留痕", () => {
  const { s } = setupFamily();
  const b1 = batches.registerBatch(s, { food_id: APPLE, grams: 100, expire_date: "2026-10-20" });
  const b2 = batches.registerBatch(s, { food_id: APPLE, grams: 100, expire_date: "2026-10-10" });
  const b3 = batches.registerBatch(s, { food_id: APPLE, grams: 100 }); // 长期有效
  const log = hh.consume(s, { food_id: APPLE, grams: 150 });
  /* 先扣 10/10 的 100g，再扣 10/20 的 50g */
  assert.deepStrictEqual(log.allocations.map(a => a.batch_id), [b2.id, b1.id]);
  assert.deepStrictEqual(log.allocations.map(a => a.grams), [100, 50]);
  const rem = id => batches.batchRemaining(s.batches.find(b => b.id === id));
  assert.strictEqual(rem(b2.id), 0);
  assert.strictEqual(rem(b1.id), 50);
  assert.strictEqual(rem(b3.id), 100);
});

t("已过期批次不可消耗：即使物理在库也报缺料并提示失效量", () => {
  const { s } = setupFamily();
  batches.registerBatch(s, { food_id: APPLE, grams: 100, expire_date: "2026-10-01" });
  try {
    hh.consume(s, { food_id: APPLE, grams: 50 });
    assert.fail("应拒绝消耗过期批次");
  } catch (e) {
    assert.strictEqual(e.code, "INSUFFICIENT_STOCK");
    assert.strictEqual(e.deficit.physical, 100);
    assert.strictEqual(e.deficit.have, 0);
    assert(/过期/.test(e.message));
  }
  assert.strictEqual(hh.stockOnHand(s).apple, 100, "未产生扣减");
});

/* ---------- 家长报废与损失 ---------- */

t("家长报废批次：扣可用库存与估值、按实际单价计本周损失", () => {
  const { s, parent } = setupFamily();
  const unit = foodsMod.getFood(APPLE).cost;
  const b = batches.registerBatch(s, { food_id: APPLE, grams: 200, unit_cost: unit, expire_date: "2026-10-01" });
  const beforeVal = hh.inventoryValue(s).total;
  const r = hh.reviewScrapBatch(s, b.id, { reason: "发霉变质" }, parent.id);
  assert(Math.abs(r.wastage_cost - Math.round(unit * 2 * 100) / 100) < 1e-6);
  assert.strictEqual(hh.stockOnHand(s).apple || 0, 0);
  assert.strictEqual(hh.usableStock(s).apple || 0, 0);
  const b2 = hh.budgetSummary(s);
  assert.strictEqual(b2.wastage_grams, 200);
  assert(b2.wastage_cost > 0);
  assert.strictEqual(b2.wastage_count, 1);
  assert(hh.inventoryValue(s).total <= beforeVal);
  assert(s.scraps.length === 1 && s.scraps[0].reason === "发霉变质");
  assert(hh.warnings(s).some(w => w.code === "batch_wastage"));
});

t("支持部分报废：剩余批次仍可继续 FEFO 消耗", () => {
  const { s, parent } = setupFamily();
  const b = batches.registerBatch(s, { food_id: APPLE, grams: 100, expire_date: "2026-10-20" });
  hh.reviewScrapBatch(s, b.id, { grams: 40, reason: "磕碰损耗" }, parent.id);
  assert.strictEqual(batches.batchRemaining(b), 60);
  assert.notStrictEqual(b.status, "scrapped");
  const log = hh.consume(s, { food_id: APPLE, grams: 60 });
  assert.strictEqual(log.allocations[0].batch_id, b.id);
  assert.strictEqual(batches.batchRemaining(b), 0);
  /* 余量耗尽是正常消耗（区别于整批报废），不改变批次报废审核标记 */
});

t("整批报废后批次状态为 scrapped 且不再参与 FEFO", () => {
  const { s, parent } = setupFamily();
  const b = batches.registerBatch(s, { food_id: APPLE, grams: 100 });
  hh.reviewScrapBatch(s, b.id, {}, parent.id);
  assert.strictEqual(b.status, "scrapped");
  assert.strictEqual(batches.fefoBatches(s, APPLE).length, 0);
  assert.throws(() => hh.consume(s, { food_id: APPLE, grams: 1 }), /可用库存不足/);
});

t("报废克重校验：非法值与超出剩余被拒绝", () => {
  const { s, parent } = setupFamily();
  const b = batches.registerBatch(s, { food_id: APPLE, grams: 50 });
  assert.throws(() => hh.reviewScrapBatch(s, b.id, { grams: 0 }, parent.id));
  assert.throws(() => hh.reviewScrapBatch(s, b.id, { grams: 999 }, parent.id));
});

/* ---------- 配餐自动避开失效食材 ---------- */

t("单日配餐库存优先只认可用库存：过期库存不抵扣净采购", () => {
  const { s } = setupFamily();
  /* 新鲜鸡胸库存 -> 可抵扣；过期西兰花 -> 不可抵扣 */
  hh.registerStockBatch(s, { food_id: "chicken_breast", grams: 400 });
  hh.registerStockBatch(s, { food_id: "broccoli", grams: 400, expire_date: "2026-09-01" });
  const sync = hh.syncInputs(s);
  assert.strictEqual(sync.stock.chicken_breast, 400);
  assert(!sync.stock.broccoli, "过期批次不进入配餐库存");
  const r = planDay({ profile: PROF, budget: 25, allergens: [], exclude: [], stock: sync.stock });
  assert.strictEqual(r.feasible, true, r.reasons.join(";"));
  assert(r.items.some(i => i.food_id === "chicken_breast"));
});

t("分餐替换候选与按日缺料均剔除过期批次", () => {
  const { s, parent, kid } = setupFamily();
  fam.buildFamilyPlan(s, {});
  /* 给某食材登记足量但已过期的库存，候选不应显示在库、按日仍缺料 */
  hh.registerStockBatch(s, { food_id: "chicken_breast", grams: 5000, expire_date: "2026-09-01" });
  const line = s.family_plan.lines.find(l => l.member_id === kid.id && l.role === "protein");
  const opts = fam.substituteOptions(s, line.id, kid.id);
  const chick = opts.options.find(o => o.food_id === "chicken_breast");
  if (chick) assert.strictEqual(chick.in_stock, 0, "过期批次不应算在库");
  fam.confirmPortions(s, { scope: "day", day: 0 }, parent.id);
  const ready = fam.familyDayReady(s, 0);
  /* 全家当日若计划食材含鸡胸，则库存缺口必须体现可用量为 0 */
  const deficitIds = ready.stock_deficits.map(d => d.food_id);
  if (deficitIds.includes("chicken_breast")) {
    const d = ready.stock_deficits.find(x => x.food_id === "chicken_breast");
    assert.strictEqual(d.have, 0);
    assert(d.physical > 0);
  }
});

/* ---------- 报废同步替换采购与预算 ---------- */

t("报废后按当前周菜单自动补替换采购，待买占用与预算同步", () => {
  const { s, parent, buyer } = setupFamily();
  const w = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w);
  hh.buildShoppingList(s, w);
  /* 全部到货，登记为批次 */
  for (const it of s.shopping.filter(i => i.status === "pending")) {
    hh.arriveItem(s, it.id, {}, buyer.id);
  }
  assert.strictEqual(hh.budgetSummary(s).committed, 0);
  /* 找一个周菜单用到的食材，构造其批次临过期并整批报废 */
  const foodId = w.days[0].items[0].food_id;
  const needTotal = w.days.reduce((sum, d) => sum + d.items.filter(i => i.food_id === foodId).reduce((x, i) => x + i.grams, 0), 0);
  const b = s.batches.find(x => x.food_id === foodId);
  hh.reviewScrapBatch(s, b.id, { grams: batches.batchRemaining(b), reason: "过期报废" }, parent.id);
  /* 净需求重新出现：若全周仍需该食材，则自动补菜单来源待买 */
  if (needTotal > 0) {
    const rebuy = s.shopping.find(i => i.source === "menu" && i.food_id === foodId && i.status === "pending");
    assert(rebuy, "报废后应自动补替换采购任务");
    assert(rebuy.grams >= needTotal);
  }
  assert(hh.budgetSummary(s).committed >= 0);
});

t("分餐菜单下报废批次自动重算分餐采购净需求", () => {
  const { s, parent, buyer } = setupFamily();
  fam.buildFamilyPlan(s, {});
  for (const it of s.shopping.filter(i => i.source === "family" && i.status === "pending")) {
    hh.arriveItem(s, it.id, {}, buyer.id);
  }
  const foodId = s.family_plan.lines[0].food_id;
  const needGrams = fam.familyNeed(s)[foodId];
  const b = s.batches.find(x => x.food_id === foodId);
  hh.reviewScrapBatch(s, b.id, { grams: batches.batchRemaining(b) }, parent.id);
  const rebuy = s.shopping.filter(i => i.source === "family" && i.food_id === foodId && i.status === "pending");
  if (needGrams > 0) {
    const total = rebuy.reduce((sum, i) => sum + i.grams, 0);
    assert(total > 0, "分餐替换采购应自动补入");
  }
});

/* ---------- 按配餐逐日消耗（可用库存口径 + FEFO） ---------- */

t("按天消耗：失效批次不抵需求给出缺料；齐备时 FEFO 扣减", () => {
  const { s, buyer } = setupFamily();
  hh.addMember(s, { name: "家长" });
  const w = weekPlan({ profile: PROF, budget: 30, allergens: [], exclude: [] });
  hh.setWeek(s, { budget: 30 }, w);
  hh.buildShoppingList(s, w);
  /* 把第 0 天所需食材到货，但给其中一种登记为已过期 */
  const day0 = w.days[0].items;
  const expireFood = day0[0].food_id;
  for (const it of s.shopping.filter(i => i.status === "pending")) {
    if (it.food_id === expireFood) hh.arriveItem(s, it.id, { expire_date: "2026-09-01" }, buyer.id);
    else hh.arriveItem(s, it.id, {}, buyer.id);
  }
  try {
    hh.consumeDay(s, 0);
    assert.fail("应因过期缺料失败");
  } catch (e) {
    assert.strictEqual(e.code, "INSUFFICIENT_STOCK");
    assert(e.deficits.some(d => d.food_id === expireFood && d.have === 0 && d.physical > 0));
  }
  /* 重新登记新鲜批次后可消耗 */
  hh.registerStockBatch(s, { food_id: expireFood, grams: 1000 }, buyer.id);
  const logs = hh.consumeDay(s, 0);
  assert(logs.length > 0);
  assert(logs.every(l => l.allocations && l.allocations.length > 0), "逐行消耗带批次分配");
});

/* ---------- 库存视图与估值 ---------- */

t("视图：库存分列可用 / 失效克重与估值，批次台账带剩余天数与状态", () => {
  const { s, parent } = setupFamily();
  batches.registerBatch(s, { food_id: APPLE, grams: 100, expire_date: "2026-10-09" });
  batches.registerBatch(s, { food_id: APPLE, grams: 80, expire_date: "2026-10-01" });
  batches.registerBatch(s, { food_id: "carrot", grams: 120 });
  hh.reviewScrapBatch(s, s.batches[1].id, {}, parent.id); // 报废过期苹果
  const v = hh.householdView(s);
  const apple = v.stock.find(x => x.food_id === APPLE);
  assert.strictEqual(apple.grams, 100); // 物理只剩新鲜批次（过期的已报废）
  assert(Array.isArray(v.batches) && v.batches.length === 3);
  assert(v.batch_summary.expired >= 0);
  assert(v.today === "2026-10-07");
  const near = v.batches.find(b => b.status_key === "near");
  assert(near && near.days_left === 2);
  const scrapped = v.batches.find(b => b.status_key === "scrapped");
  assert(scrapped && scrapped.remaining === 0);
  assert(v.scraps.length === 1);
});

t("批次按紧急度排序：过期 / 待确认临期排最前", () => {
  const { s } = setupFamily();
  batches.registerBatch(s, { food_id: "carrot", grams: 50, expire_date: "2026-12-01" });
  batches.registerBatch(s, { food_id: APPLE, grams: 50, expire_date: "2026-10-09" });
  batches.registerBatch(s, { food_id: "banana", grams: 50, expire_date: "2026-10-01" });
  const list = batches.batchListView(s);
  assert.strictEqual(list[0].food_id, "banana", "过期排第一");
  assert.strictEqual(list[1].food_id, APPLE, "临期待审核排第二");
});

/* ---------- 期初 / 盘库批次 ---------- */

t("盘库录入生成长效 stocktake 批次，再次录入替换旧盘库批次", () => {
  const { s, buyer } = setupFamily();
  hh.setManualStock(s, APPLE, 300, { expire_date: "2026-10-20" }, buyer.id);
  assert.strictEqual(s.batches.length, 1);
  assert.strictEqual(s.batches[0].source, "stocktake");
  assert.strictEqual(hh.stockOnHand(s).apple, 300);
  hh.setManualStock(s, APPLE, 100, {}, buyer.id);
  assert.strictEqual(s.batches.filter(b => b.food_id === APPLE).length, 1);
  assert.strictEqual(hh.stockOnHand(s).apple, 100);
  hh.setManualStock(s, APPLE, 0, {}, buyer.id);
  assert(!s.batches.some(b => b.food_id === APPLE));
});

/* ---------- 周期切换 ---------- */

t("报废损失按周期归集，跨周期后本周损失清零、批次库存结转", () => {
  const { s, parent } = setupFamily();
  const b = batches.registerBatch(s, { food_id: APPLE, grams: 100, unit_cost: 10 });
  hh.reviewScrapBatch(s, b.id, {}, parent.id);
  assert(hh.budgetSummary(s).wastage_count === 1);
  hh.startNewCycle(s);
  const b2 = hh.budgetSummary(s);
  assert.strictEqual(b2.wastage_count, 0);
  assert.strictEqual(b2.wastage_cost, 0);
  assert(s.scraps[0].cycle === 1, "报废记录保留原周期可追溯");
});

/* ---------- 旧状态迁移 ---------- */

t("历史状态迁移：旧库存重建为批次，物理库存总量与旧口径完全一致", () => {
  /* 手工构造批次台账上线前的状态：manual + arrived + consumption */
  const legacy = {
    ...hh.emptyHousehold(),
    batches: undefined, scraps: undefined, batch_events: undefined,
    stock_manual: { apple: 300, carrot: 50 },
  };
  /* 一条已到货采购：苹果 200g，实付 3.0 元 */
  legacy.shopping.push({
    id: legacy.next_item_id++, cycle: 1, source: "manual", food_id: "apple",
    grams: 200, est_cost: 2.4, assignee: null, status: "arrived",
    arrived_grams: 200, actual_cost: 3.0, arrived_by: null,
  });
  /* 已消耗苹果 250g（先扣采购 200，再扣期初 50） */
  legacy.consumption.push({ id: legacy.next_log_id++, cycle: 1, food_id: "apple", grams: 250, source: "manual", day_index: null, member: null });

  /* 旧口径在库：apple 300+200-250=250；carrot 50 */
  const oldOn = (() => {
    const map = {};
    for (const [id, g] of Object.entries(legacy.stock_manual)) map[id] = (map[id] || 0) + g;
    for (const it of legacy.shopping) if (it.status === "arrived") map[it.food_id] = (map[it.food_id] || 0) + it.arrived_grams;
    for (const l of legacy.consumption) map[l.food_id] -= l.grams;
    return map;
  })();

  batches.migrateBatches(legacy);
  assert(Array.isArray(legacy.batches) && legacy.batches.length === 2);
  const on = hh.stockOnHand(legacy);
  assert.strictEqual(on.apple, oldOn.apple);
  assert.strictEqual(on.carrot, oldOn.carrot);
  /* 迁移批次无到期日 -> 全部可用，估值与旧加权口径一致 */
  assert.strictEqual(hh.usableStock(legacy).apple, 250);
  const v = hh.inventoryValue(legacy);
  /* 旧口径：采购 0 剩余；期初 250g 按 db 价；carrot 50g 按 db 价 */
  const appleDb = foodsMod.getFood("apple").cost;
  const carrotDb = foodsMod.getFood("carrot").cost;
  const expect = Math.round((250 * appleDb + 50 * carrotDb)) / 100;
  assert(Math.abs(v.total - expect) < 0.02, `估值迁移不符: ${v.total} vs ${expect}`);
  /* 迁移幂等：再次调用不重复建批次 */
  assert.strictEqual(batches.migrateBatches(legacy), false);
});

t("迁移后 FEFO 消耗与新登记批次正常协作", () => {
  const legacy = { ...hh.emptyHousehold(), stock_manual: { apple: 100 } };
  batches.migrateBatches(legacy);
  hh.setClock(legacy, "2026-10-07");
  const fresh = batches.registerBatch(legacy, { food_id: "apple", grams: 100, expire_date: "2026-10-09" });
  const log = hh.consume(legacy, { food_id: "apple", grams: 120 });
  /* 临期新批次先吃 100g，再吃迁移长效批次 20g */
  assert.strictEqual(log.allocations[0].batch_id, fresh.id);
  assert.strictEqual(log.allocations[0].grams, 100);
  assert.strictEqual(log.allocations[1].grams, 20);
});

/* ---------- 事件流与追溯 ---------- */

t("批次事件流记录登记 / 继续使用 / 报废，含操作人与原因", () => {
  const { s, parent, buyer } = setupFamily();
  hh.registerStockBatch(s, { food_id: APPLE, grams: 100, expire_date: "2026-10-09", note: "早市" }, buyer.id);
  hh.keepBatch(s, s.batches[0].id, parent.id, "今天做派");
  hh.reviewScrapBatch(s, s.batches[0].id, { grams: 10, reason: "碰伤" }, parent.id);
  const kinds = s.batch_events.map(e => e.kind);
  assert(kinds.includes("batch_register"));
  assert(kinds.includes("batch_keep"));
  assert(kinds.includes("batch_scrap"));
  const reg = s.batch_events.find(e => e.kind === "batch_register");
  assert.strictEqual(reg.by, buyer.id);
  assert.strictEqual(reg.note, "早市");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

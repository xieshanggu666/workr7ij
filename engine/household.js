"use strict";
/* 家庭采购与库存管理：
   1. 家庭成员维护过敏原，全家规避清单取并集（严格规避）；
   2. 基于周菜单按毛重聚合净需求（需求 - 在库 - 待买，含 10% 安全余量并按 10g 取整），
      生成采购清单并按成员当前负载分工；
   3. 确认到货（可登记实际克重与实际单价）后入库存并计入实际支出，含过敏原食材拦截；
   4. 按配餐 / 手动消耗扣减库存，并累计本周已用次数（供食材周限次约束使用）；
   5. 库存变化同步预算（已采购 / 待买 / 剩余）、过敏规避（在库致敏预警）与后续配餐
      （库存优先、零边际采购成本、weekly_used 限次）。
   所有克重均与配餐一致，使用毛重（计价口径）。状态为纯数据对象，便于持久化与测试。 */

const { getFood, costFor, ALLERGENS } = require("./foods");
const { PROFILE_KEYS, ACTIVITY_KEYS, GOAL_KEYS } = require("./requirements");
const batchesMod = require("./batches");

const ROUND_G = 10;        // 采购克重取整步长
const SAFETY_FACTOR = 1.1; // 采购安全余量

/* 家庭分餐协作角色：家长确认份量；成员确认替换；采购负责人确认到货。
   null / "any" 表示未指定角色（向后兼容，权限校验放行）。 */
const MEMBER_ROLES = { parent: "家长", member: "成员", buyer: "采购负责人" };

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }
function roundUp(g) { return Math.max(ROUND_G, Math.ceil((g - 1e-9) / ROUND_G) * ROUND_G); }

function emptyHousehold() {
  return {
    version: 1,
    cycle_no: 1,            // 采购周期（周）序号，新周期库存结转、限次计数清零
    weekly_budget: 175,
    today: null,            // 业务日期（YYYY-MM-DD），null=跟随系统当天；保质期判定基准
    near_days: batchesMod.DEFAULT_NEAR_DAYS, // 临期预警阈值（剩余天数）
    members: [],
    next_member_id: 1,
    shopping: [],           // {id, cycle, source:"menu"|"manual"|"family", food_id, grams, est_cost, assignee, status, arrived_grams, actual_cost, arrived_by}
    consumption: [],        // {id, cycle, food_id, grams, source:"plan"|"manual", day_index, member, allocations:[{batch_id, grams}]}
    stock_manual: {},       // 期初 / 盘库（迁移兼容字段；新入库走批次台账 batches）
    batches: [],            // 食材批次台账 {id, cycle, source, shopping_id, food_id, grams, consumed_grams, scrapped_grams, unit_cost, produced_date, expire_date, shelf_days, near_acked, status, ...}
    scraps: [],             // 报废记录 {id, cycle, batch_id, food_id, grams, unit_cost, cost, reason_status, reason, by, ts}
    batch_events: [],       // 批次事件流（登记 / 临期确认 / 报废），批次维度可追溯
    consumed_days: [],      // 当前周期已按配餐消耗的日序号
    week: null,             // 最近一次联动生成的周菜单 {cycle, params, plan}，cycle 为菜单所属采购周
    family_plan: null,      // 家庭分餐协作菜单（按成员营养目标生成，行级份量 / 替换 / 到货 / 消耗可追溯）
    next_item_id: 1,
    next_log_id: 1,
    next_line_id: 1,
    next_event_id: 1,
    next_batch_id: 1,
    next_scrap_id: 1,
    next_batch_event_id: 1,
  };
}

/* ---------------- 家庭成员 ---------------- */

function sanitizeProfile(profile) {
  const p = profile || {};
  return {
    age_group: PROFILE_KEYS[p.age_group] ? p.age_group : "adult_m",
    activity: ACTIVITY_KEYS[p.activity] ? p.activity : "moderate",
    goal: GOAL_KEYS[p.goal] ? p.goal : "maintain",
  };
}

function validateAllergens(list) {
  for (const a of list || []) {
    if (!ALLERGENS.includes(a)) throw new Error("未知过敏原：" + a);
  }
}

function sanitizeExclude(list) {
  const out = [];
  for (const id of list || []) {
    if (!getFood(id)) throw new Error("未知食材：" + id);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function sanitizeRole(role) {
  if (role == null || role === "" || role === "any") return null;
  if (!MEMBER_ROLES[role]) throw new Error("未知成员角色：" + role);
  return role;
}

function familyAllergens(members) {
  const set = new Set();
  for (const m of members || []) (m.allergens || []).forEach(a => set.add(a));
  return [...set];
}

function addMember(state, input) {
  const name = String((input && input.name) || "").trim();
  if (!name) throw new Error("成员名称不能为空");
  if (state.members.some(m => m.name === name)) throw new Error("成员名称已存在：" + name);
  validateAllergens(input.allergens);
  const member = {
    id: state.next_member_id++,
    name,
    profile: sanitizeProfile(input.profile),
    allergens: [...new Set(input.allergens || [])],
    role: sanitizeRole(input.role),
    exclude: sanitizeExclude(input.exclude),
  };
  state.members.push(member);
  return member;
}

function updateMember(state, id, patch) {
  const m = state.members.find(x => x.id === id);
  if (!m) throw new Error("成员不存在");
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new Error("成员名称不能为空");
    if (state.members.some(x => x.name === name && x.id !== id)) throw new Error("成员名称已存在：" + name);
    m.name = name;
  }
  if (patch.profile) m.profile = sanitizeProfile(patch.profile);
  if (patch.allergens) {
    validateAllergens(patch.allergens);
    m.allergens = [...new Set(patch.allergens)];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "role")) m.role = sanitizeRole(patch.role);
  if (patch.exclude) m.exclude = sanitizeExclude(patch.exclude);
  return m;
}

function removeMember(state, id) {
  const idx = state.members.findIndex(x => x.id === id);
  if (idx < 0) throw new Error("成员不存在");
  state.members.splice(idx, 1);
  /* 该成员名下采购任务改为未分配，任务本身保留 */
  for (const it of state.shopping) if (it.assignee === id) it.assignee = null;
}

/* ---------------- 库存核算（批次台账口径） ---------------- */

/* 物理在库（毛重克，含已过期但尚未报废的批次）= 各批次剩余之和。
   未迁移的旧状态回退到旧公式（manual + 到货 - 消耗）。 */
function stockOnHand(state) {
  if (Array.isArray(state.batches)) {
    const map = batchesMod.stockOnHandBatches(state);
    for (const id of Object.keys(map)) map[id] = Math.max(0, round1(map[id]));
    return map;
  }
  const map = {};
  for (const [id, g] of Object.entries(state.stock_manual || {})) map[id] = (map[id] || 0) + Number(g) || 0;
  for (const it of state.shopping) {
    if (it.status === "arrived") map[it.food_id] = (map[it.food_id] || 0) + (it.arrived_grams || 0);
  }
  for (const log of state.consumption) map[log.food_id] = (map[log.food_id] || 0) - log.grams;
  for (const id of Object.keys(map)) map[id] = Math.max(0, round1(map[id]));
  return map;
}

/* 可用库存：剔除已过期 / 已报废批次——配餐库存优先、净采购抵扣、缺料 / 替换采购均以此为准。
   临期批次仍可用（消耗时 FEFO 先到期优先），家长确认“继续使用”或报废前一直保留在可用口径。 */
function usableStock(state, today) {
  if (Array.isArray(state.batches)) return batchesMod.usableStockMap(state, today);
  return stockOnHand(state);
}

/* 失效库存（过期未报废 + 已报废仍记账的物理余量），仅供预警 / 视图列示 */
function unusableStock(state, today) {
  if (Array.isArray(state.batches)) return batchesMod.unusableStockMap(state, today);
  return {};
}

/* 库存估值：可配餐批次按批次实际单价计价，过期 / 报废批次单列 unusable_total。
   未迁移旧状态沿用旧的加权口径，保证升级前后数值一致。 */
function inventoryValue(state, onHand) {
  if (Array.isArray(state.batches)) {
    const v = batchesMod.inventoryValueByBatches(state);
    return { total: v.total, per: v.per, usable_total: v.usable_total, unusable_total: v.unusable_total, unusable_per: v.unusable_per };
  }
  const on = onHand || stockOnHand(state);
  const pur = {};
  for (const it of state.shopping) {
    if (it.status !== "arrived") continue;
    pur[it.food_id] = pur[it.food_id] || { g: 0, cost: 0 };
    pur[it.food_id].g += it.arrived_grams || 0;
    pur[it.food_id].cost += it.actual_cost || 0;
  }
  const per = {};
  let total = 0;
  for (const id of Object.keys(on)) {
    const have = on[id];
    if (have <= 0) continue;
    const manual = state.stock_manual[id] || 0;
    const fromManual = Math.min(have, manual);
    const fromPur = Math.max(0, have - fromManual);
    const f = getFood(id);
    const dbPrice = f ? f.cost / 100 : 0;
    let v = fromManual * dbPrice;
    const p = pur[id];
    if (fromPur > 0 && p && p.g > 0) v += fromPur * (p.cost / p.g);
    per[id] = round2(v);
    total += v;
  }
  return { total: round2(total), per };
}

/* ---------------- 预算 ---------------- */

function budgetSummary(state) {
  const budget = Number(state.weekly_budget) || 0;
  const items = state.shopping.filter(i => i.cycle === state.cycle_no);
  const spent = round2(items.filter(i => i.status === "arrived").reduce((s, i) => s + (i.actual_cost || 0), 0));
  const estSpent = round2(items.filter(i => i.status === "arrived").reduce((s, i) => s + (i.est_cost || 0), 0));
  const committed = round2(items.filter(i => i.status === "pending").reduce((s, i) => s + (i.est_cost || 0), 0));
  /* 本周家长审核报废的食材损失（按批次实际单价），计入本周预算占用 */
  const waste = Array.isArray(state.scraps) ? batchesMod.wastageSummary(state) : { cost: 0, grams: 0, count: 0 };
  const projected = round2(spent + committed);
  return {
    budget: round2(budget),
    spent,                       // 已实际采购支出
    price_delta: round2(spent - estSpent), // 实际价与预估偏差
    committed,                   // 待买预估占用（含报废后自动补入的替换采购）
    projected,                   // 预计本周采购总支出
    remaining: round2(budget - projected),
    over: projected > budget,
    wastage_cost: waste.cost,    // 本周报废损失（食材成本，沉没不计入 projected，单列预警）
    wastage_grams: waste.grams,
    wastage_count: waste.count,
  };
}

/* ---------------- 采购清单 ---------------- */

function assertFood(foodId) {
  const f = getFood(foodId);
  if (!f) throw new Error("未知食材：" + foodId);
  return f;
}

/* 角色校验（与分餐协作一致）：actorId 缺省 => 系统 / 脚本调用放行；
   指定时该成员必须存在，其 role 已分工则必须匹配所需角色（家长 / 采购负责人）。 */
function assertActorRole(state, actorId, role) {
  if (actorId == null) return;
  const actor = state.members.find(m => m.id === Number(actorId));
  if (!actor) throw new Error("操作人不是家庭成员");
  if (actor.role && actor.role !== role) {
    throw new Error(`仅${role === "parent" ? "家长" : role === "buyer" ? "采购负责人" : "成员"}可执行此操作`);
  }
}

function assertNoFamilyAllergen(state, food) {
  const block = (food.allergens || []).filter(a => familyAllergens(state.members).includes(a));
  if (block.length) throw new Error(`「${food.name}」含全家规避过敏原 ${block.join("、")}，已拦截`);
}

function currentItems(state) {
  return state.shopping.filter(i => i.cycle === state.cycle_no);
}

/* 按成员当前待买金额负载选择最空闲者（金额相同取 id 最小，保证确定性），无成员返回 null */
function leastLoadedMember(state) {
  if (!state.members.length) return null;
  const load = {};
  state.members.forEach(m => { load[m.id] = 0; });
  for (const it of currentItems(state)) {
    if (it.status === "pending" && it.assignee != null && load[it.assignee] != null) {
      load[it.assignee] += it.est_cost || 0;
    }
  }
  return [...state.members].sort((a, b) => (load[a.id] - load[b.id]) || (a.id - b.id))[0].id;
}

/* 根据周菜单（重新）生成菜单来源采购项；保留已有任务的负责人，库存与待买自动抵扣。
   opts.source 指定来源标签（"menu" 单日视图周菜单 / "family" 家庭分餐菜单），
   不同来源的任务互不清理，各自只跟踪自身来源的净需求。 */
function buildShoppingList(state, week, opts) {
  opts = opts || {};
  const source = opts.source === "family" ? "family" : "menu";
  if (!week || !Array.isArray(week.days)) throw new Error("缺少周菜单");
  const avoid = new Set(familyAllergens(state.members));
  /* 只有未过期 / 未报废批次才能抵扣净需求：报废后可用库存下降，自动产生替换采购 */
  const on = usableStock(state);

  const need = {};
  for (const day of week.days) {
    for (const it of day.items) need[it.food_id] = (need[it.food_id] || 0) + it.grams;
  }

  const cycItems = currentItems(state);
  const pendingSource = {};
  const pendingGrams = {};
  for (const it of cycItems) {
    if (it.status !== "pending") continue;
    if (it.source === source && !pendingSource[it.food_id]) pendingSource[it.food_id] = it;
  }
  /* 待买抵扣只统计“外部任务”：本来源正在跟踪的旧任务即将被重建，不能抵扣自身 */
  for (const it of cycItems) {
    if (it.status !== "pending") continue;
    if (pendingSource[it.food_id] === it) continue;
    pendingGrams[it.food_id] = (pendingGrams[it.food_id] || 0) + it.grams;
  }

  const keep = new Set();
  for (const [foodId, needGrams] of Object.entries(need)) {
    const f = getFood(foodId);
    if (!f) continue;
    if ((f.allergens || []).some(a => avoid.has(a))) continue; // 双重保险：配餐已规避
    const target = roundUp(needGrams * SAFETY_FACTOR);
    const net = target - (on[foodId] || 0) - (pendingGrams[foodId] || 0);
    const existing = pendingSource[foodId];
    if (net > 0) {
      const grams = roundUp(net);
      if (existing) {
        existing.grams = grams;
        existing.est_cost = round2(costFor(f, grams));
        keep.add(existing.id);
      } else {
        const assignee = leastLoadedMember(state);
        const item = {
          id: state.next_item_id++,
          cycle: state.cycle_no,
          source,
          food_id: foodId,
          grams,
          est_cost: round2(costFor(f, grams)),
          assignee,
          status: "pending",
          arrived_grams: 0,
          actual_cost: 0,
        };
        state.shopping.push(item);
        keep.add(item.id);
      }
    } else if (existing) {
      /* 库存 / 待买已覆盖需求：移除该来源任务（其他来源与手动添加项不动） */
      state.shopping = state.shopping.filter(x => x.id !== existing.id);
    }
  }
  /* 菜单中已消失的食材：清理本来源的待买任务 */
  for (const it of [...cycItems]) {
    if (it.source === source && it.status === "pending" && !keep.has(it.id) && need[it.food_id] == null) {
      state.shopping = state.shopping.filter(x => x.id !== it.id);
    }
  }
  return state.shopping.filter(i => i.cycle === state.cycle_no);
}

function addManualItem(state, input) {
  const f = assertFood(input.food_id);
  assertNoFamilyAllergen(state, f);
  const grams = Math.round(Number(input.grams));
  if (!(grams > 0)) throw new Error("采购克重必须为正数");
  let assignee = null;
  if (input.assignee != null) {
    if (!state.members.some(m => m.id === input.assignee)) throw new Error("负责人不存在");
    assignee = input.assignee;
  }
  const item = {
    id: state.next_item_id++,
    cycle: state.cycle_no,
    source: "manual",
    food_id: f.id,
    grams,
    est_cost: round2(costFor(f, grams)),
    assignee,
    status: "pending",
    arrived_grams: 0,
    actual_cost: 0,
  };
  state.shopping.push(item);
  return item;
}

function assignItem(state, itemId, memberId) {
  const it = state.shopping.find(x => x.id === itemId && x.cycle === state.cycle_no);
  if (!it) throw new Error("采购任务不存在");
  if (memberId != null && !state.members.some(m => m.id === memberId)) throw new Error("负责人不存在");
  it.assignee = memberId == null ? null : memberId;
  return it;
}

function removeItem(state, itemId) {
  const idx = state.shopping.findIndex(x => x.id === itemId && x.cycle === state.cycle_no);
  if (idx < 0) throw new Error("采购任务不存在");
  const [it] = state.shopping.splice(idx, 1);
  if (it.status === "arrived" && Array.isArray(state.batches)) {
    /* 已到货任务被删除：同步移除其关联批次（库存核算自动重算），报废记录保留可追溯 */
    state.batches = state.batches.filter(b => b.shopping_id !== it.id);
  }
  return it;
}

/* 确认到货：可登记实际克重与实际单价（元/100g），缺省按预估；
   同时由采购负责人登记保质期批次（produced_date + shelf_days 或 expire_date，均可空=长期有效）。 */
function arriveItem(state, itemId, opts, actorId) {
  opts = opts || {};
  assertActorRole(state, actorId, "buyer");
  const it = state.shopping.find(x => x.id === itemId && x.cycle === state.cycle_no);
  if (!it) throw new Error("采购任务不存在");
  if (it.status !== "pending") throw new Error("该任务已确认到货");
  const f = assertFood(it.food_id);
  assertNoFamilyAllergen(state, f);
  const grams = opts.grams != null ? Math.round(Number(opts.grams)) : it.grams;
  if (!(grams > 0)) throw new Error("到货克重必须为正数");
  const unitCost = opts.unit_cost != null ? Number(opts.unit_cost) : f.cost;
  if (!(unitCost >= 0)) throw new Error("实际单价非法");
  it.status = "arrived";
  it.arrived_grams = grams;
  it.actual_cost = round2((unitCost * grams) / 100);
  if (opts.arrived_by != null) it.arrived_by = Number(opts.arrived_by);
  /* 登记到货批次（保质期信息缺省时为长期有效批次，可后续在批次台账补登） */
  if (Array.isArray(state.batches)) {
    const regBy = actorId != null ? Number(actorId) : (it.arrived_by != null ? it.arrived_by : null);
    batchesMod.registerBatch(state, {
      source: "arrive", shopping_id: it.id, food_id: f.id, grams,
      unit_cost: unitCost,
      produced_date: opts.produced_date, shelf_days: opts.shelf_days, expire_date: opts.expire_date,
      note: opts.note || null,
    }, regBy);
  }
  return it;
}

/* ---------------- 消耗 ---------------- */

/* 手动 / 按配餐消耗：按 FEFO（先到期先消耗、临期优先）在可用批次上扣减，
   不允许消耗已过期 / 已报废批次；每次消耗记录逐批次 allocations，行级可追溯。 */
function consume(state, input) {
  const f = assertFood(input.food_id);
  const grams = Math.round(Number(input.grams) * 10) / 10;
  if (!(grams > 0)) throw new Error("消耗克重必须为正数");
  const useBatches = Array.isArray(state.batches);
  const on = useBatches ? usableStock(state) : stockOnHand(state);
  if ((on[f.id] || 0) + 1e-6 < grams) {
    const physical = stockOnHand(state)[f.id] || 0;
    const unusable = Math.max(0, round1(physical - (on[f.id] || 0)));
    let msg = `「${f.name}」可用库存不足：可用 ${on[f.id] || 0}g，消耗 ${grams}g`;
    if (unusable > 0) msg += `（另有 ${unusable}g 已过期 / 报废，请家长先审核处理）`;
    const err = new Error(msg);
    err.code = "INSUFFICIENT_STOCK";
    err.deficit = { food_id: f.id, name: f.name, have: on[f.id] || 0, physical, need: grams };
    throw err;
  }
  let allocations = null;
  if (useBatches) {
    const plan = batchesMod.planFefo(state, f.id, grams);
    if (plan.shortage > 1e-6) {
      const err = new Error(`「${f.name}」FEFO 分配失败：缺少 ${plan.shortage}g 可用批次`);
      err.code = "INSUFFICIENT_STOCK";
      throw err;
    }
    allocations = batchesMod.applyConsumptionAllocations(state, plan.allocations);
  }
  const log = {
    id: state.next_log_id++,
    cycle: state.cycle_no,
    food_id: f.id,
    grams,
    source: input.source === "plan" ? "plan" : "manual",
    day_index: Number.isInteger(input.day_index) ? input.day_index : null,
    member: input.member || null,
    allocations,
  };
  state.consumption.push(log);
  return log;
}

function setWeek(state, params, plan) {
  /* 菜单版本与采购周期绑定：周期切换后旧菜单仅可追溯，不可再次确认入账 */
  state.week = { cycle: state.cycle_no, params: params || null, plan: plan || null };
}

/* 当前联动菜单是否属于本采购周 */
function weekIsCurrent(state) {
  return !!(state.week && state.week.plan && state.week.cycle === state.cycle_no);
}

/* 按周菜单中某一天的配餐一次性消耗（克重与配餐一致）；每日不可重复确认，
   且菜单必须属于当前采购周——旧周菜单的消耗记录保留在原周期可追溯，但不能在新周期重复入账 */
function consumeDay(state, dayIndex) {
  if (!state.week || !state.week.plan) throw new Error("尚未生成联动周菜单");
  if (!weekIsCurrent(state)) {
    const err = new Error(
      `该菜单属于第 ${state.week.cycle == null ? "?" : state.week.cycle} 采购周，当前为第 ${state.cycle_no} 周：` +
      `旧周消耗记录保留可追溯，但不能重复入账，请重新生成本周菜单`
    );
    err.code = "STALE_WEEK";
    throw err;
  }
  const plan = state.week.plan;
  dayIndex = Number(dayIndex);
  if (!(dayIndex >= 0 && dayIndex < plan.days.length)) throw new Error("日期序号非法");
  if (state.consumed_days.includes(dayIndex)) throw new Error("该日配餐已确认消耗");

  const day = plan.days[dayIndex];
  const need = {};
  for (const it of day.items) need[it.food_id] = (need[it.food_id] || 0) + it.grams;
  const on = usableStock(state);
  const deficits = [];
  for (const [id, g] of Object.entries(need)) {
    if ((on[id] || 0) + 1e-6 < g) {
      const f = getFood(id);
      const physical = stockOnHand(state)[id] || 0;
      deficits.push({ food_id: id, name: f ? f.name : id, have: on[id] || 0, physical, need: g, short: round1(g - (on[id] || 0)) });
    }
  }
  if (deficits.length) {
    const err = new Error("库存不足，请先确认采购到货：" + deficits.map(d => `${d.name}缺${d.short}g`).join("；"));
    err.code = "INSUFFICIENT_STOCK";
    err.deficits = deficits;
    throw err;
  }
  const logs = [];
  for (const [id, g] of Object.entries(need)) {
    logs.push(consume(state, { food_id: id, grams: g, source: "plan", day_index: dayIndex }));
  }
  state.consumed_days.push(dayIndex);
  state.consumed_days.sort((a, b) => a - b);
  return logs;
}

/* 期初 / 盘库录入（允许录入含过敏原的存货，但会出现在规避预警中）。
   批次口径：把该食材的盘库余量重置为 g（替换既有 stocktake 批次，不影响到货批次），
   允许同时登记保质期；未迁移旧状态仍写 stock_manual 字段。g=0 清除盘库批次。 */
function setManualStock(state, foodId, grams, opts, actorId) {
  const f = assertFood(foodId);
  const g = Math.round(Number(grams) * 10) / 10;
  if (!(g >= 0)) throw new Error("克重非法");
  assertActorRole(state, actorId, "buyer");
  if (Array.isArray(state.batches)) {
    state.batches = state.batches.filter(b => !(b.source === "stocktake" && b.food_id === f.id));
    if (g > 0) {
      batchesMod.registerBatch(state, Object.assign({
        source: "stocktake", food_id: f.id, grams: g,
        unit_cost: f.cost, note: "期初 / 盘库录入",
      }, opts || {}), actorId == null ? null : Number(actorId));
    }
    return;
  }
  if (g === 0) delete state.stock_manual[f.id];
  else state.stock_manual[f.id] = g;
}

/* ---------------- 周期与配餐同步 ---------------- */

function startNewCycle(state) {
  state.cycle_no += 1;
  /* 未到货任务结转至新周期继续采购；已到货条目保留旧周期标签用于库存核算 */
  for (const it of state.shopping) if (it.status === "pending") it.cycle = state.cycle_no;
  /* 消耗日序按周期重新计数；历史消耗记录保留原周期标签（库存核算与追溯不受影响），
     旧周菜单因 cycle 标签过期自动失效，不可在新周期重复入账 */
  state.consumed_days = [];
}

/* 本周各食材已消耗次数（含按配餐与手动消耗），供周限次约束使用 */
function weeklyUsed(state) {
  const counts = {};
  for (const log of state.consumption) {
    if (log.cycle === state.cycle_no) counts[log.food_id] = (counts[log.food_id] || 0) + 1;
  }
  return counts;
}

/* 后续配餐输入：可用库存（自动避开失效批次）、过敏原并集、本周限次 */
function syncInputs(state) {
  return { allergens: familyAllergens(state.members), weekly_used: weeklyUsed(state), stock: usableStock(state) };
}

/* ---------------- 批次：业务日期 / 家长审核 / 替换采购同步 ---------------- */

/* 设置业务日期（保质期判定基准）与临期阈值；date 传 null 恢复系统当天 */
function setClock(state, date, nearDays) {
  batchesMod.setBusinessDate(state, date);
  if (nearDays != null) batchesMod.setNearDays(state, nearDays);
  return { today: batchesMod.businessDate(state), near_days: batchesMod.nearDaysOf(state) };
}

/* 采购负责人对采购渠道外的食材直接登记批次（如邻居赠送 / 市场现买未走采购单），
   或为已到货但未登记保质期的批次补登（batch_id）。 */
function registerStockBatch(state, input, actorId) {
  if (!Array.isArray(state.batches)) throw new Error("批次台账尚未初始化");
  assertActorRole(state, actorId, "buyer");
  return batchesMod.registerBatch(state, Object.assign({ source: "stocktake" }, input), actorId == null ? null : Number(actorId));
}

/* 家长确认临期批次继续使用（不再临期预警；过期仍自动失效） */
function keepBatch(state, batchId, actorId, note) {
  assertActorRole(state, actorId, "parent");
  return batchesMod.acknowledgeNear(state, batchId, actorId, note);
}

/* 家长审核报废：报废后立即扣减可用库存与库存估值、记本周损失，并自动重算
   周菜单来源 + 分餐来源采购净需求（报废造成的缺口即替换采购，计入预算占用）。
   可选 opts.no_resync=true 仅报废不同步（供上层自定义编排）。 */
function reviewScrapBatch(state, batchId, opts, actorId) {
  opts = opts || {};
  assertActorRole(state, actorId, "parent");
  const result = batchesMod.scrapBatch(state, batchId, opts, actorId);
  if (!opts.no_resync) resyncShoppingAfterStockChange(state);
  return result;
}

/* 库存变化（报废 / 批次登记）后：按当前周菜单与分餐菜单重算净需求，自动补替换采购。
   family.js 通过 ensureFamilyResync 注入分餐重算函数，避免 require 循环依赖。 */
let familyResyncHook = null;
function setFamilyResyncHook(fn) { familyResyncHook = fn; }

function resyncShoppingAfterStockChange(state) {
  /* 周菜单来源 */
  if (weekIsCurrent(state) && state.week.plan) {
    buildShoppingList(state, state.week.plan, { source: "menu" });
  }
  /* 分餐来源（仅当前周期菜单） */
  if (state.family_plan && state.family_plan.cycle === state.cycle_no && typeof familyResyncHook === "function") {
    familyResyncHook(state);
  }
}

/* ---------------- 预警 ---------------- */

function warnings(state, onHand) {
  const on = usableStock(state);
  const physical = onHand || stockOnHand(state);
  const avoid = familyAllergens(state.members);
  const out = [];

  /* 批次保质期预警优先（过期 / 临期待审核 / 本周报废损失） */
  if (Array.isArray(state.batches)) out.push(...batchesMod.batchWarnings(state));

  /* 过敏原在库预警只看仍可用于配餐的库存（失效批次已在保质期预警中处理） */
  for (const [id, g] of Object.entries(on)) {
    if (g <= 0) continue;
    const f = getFood(id);
    if (!f) continue;
    const hit = (f.allergens || []).filter(a => avoid.includes(a));
    if (hit.length) out.push({ level: "danger", code: "allergen_stock", text: `可用库存「${f.name}」含全家规避过敏原 ${hit.join("、")}，请勿用于家庭配餐` });
  }
  for (const it of currentItems(state)) {
    if (it.status !== "pending") continue;
    const f = getFood(it.food_id);
    if (!f) continue;
    const hit = (f.allergens || []).filter(a => avoid.includes(a));
    if (hit.length) out.push({ level: "danger", code: "allergen_pending", text: `待买「${f.name}」含全家规避过敏原 ${hit.join("、")}` });
  }

  const budget = budgetSummary(state);
  if (budget.over) {
    out.push({ level: "danger", code: "budget_over", text: `本周预计支出 ¥${budget.projected} 超出预算 ¥${budget.budget}，超支 ¥${round2(-budget.remaining)}` });
  }

  /* 缺料预警仅针对本周期菜单，按“可用库存（自动避开失效批次）”核算；
     旧周菜单已过期，不再驱动新周期的采购提示。报废造成的缺口由替换采购补齐。 */
  if (weekIsCurrent(state)) {
    const pendingGrams = {};
    for (const it of currentItems(state)) {
      if (it.status === "pending") pendingGrams[it.food_id] = (pendingGrams[it.food_id] || 0) + it.grams;
    }
    const need = {};
    state.week.plan.days.forEach((day, idx) => {
      if (state.consumed_days.includes(idx)) return;
      for (const it of day.items) need[it.food_id] = (need[it.food_id] || 0) + it.grams;
    });
    for (const [id, g] of Object.entries(need)) {
      const gap = g - (on[id] || 0) - (pendingGrams[id] || 0);
      if (gap > 1e-6) {
        const f = getFood(id);
        const dead = round1(Math.max(0, (physical[id] || 0) - (on[id] || 0)));
        out.push({ level: "warn", code: "shortage", text: `后续配餐缺料：${f ? f.name : id} 还需 ${roundUp(gap)}g（可用 ${on[id] || 0}g${dead > 0 ? `，另有 ${dead}g 失效待处理` : ""} / 待买 ${pendingGrams[id] || 0}g）` });
      }
    }
  }
  return out;
}

/* ---------------- 视图快照 ---------------- */

function decorateItem(state, it) {
  const f = getFood(it.food_id);
  const avoid = new Set(familyAllergens(state.members));
  return {
    ...it,
    name: f ? f.name : it.food_id,
    cat_label: f ? f.cat : "",
    source_label: it.source === "family" ? "分餐" : it.source === "manual" ? "手动" : "周菜单",
    allergens: f ? [...f.allergens] : [],
    allergen_flag: f ? f.allergens.some(a => avoid.has(a)) : false,
    assignee_name: it.assignee != null ? (state.members.find(m => m.id === it.assignee) || {}).name : null,
    arrived_by_name: it.arrived_by != null ? (state.members.find(m => m.id === it.arrived_by) || {}).name : null,
  };
}

function householdView(state) {
  const on = stockOnHand(state);
  const usable = usableStock(state);
  const unusable = unusableStock(state);
  const value = inventoryValue(state, on);
  const avoid = new Set(familyAllergens(state.members));
  const today = batchesMod.businessDate(state);
  const stock = Object.entries(on)
    .filter(([, g]) => g > 0)
    .map(([id, g]) => {
      const f = getFood(id);
      const usableG = usable[id] || 0;
      return {
        food_id: id, name: f ? f.name : id, cat: f ? f.cat : "", cat_label: f ? f.cat_label || "" : "",
        grams: g, usable_grams: usableG, unusable_grams: round1(g - usableG),
        value: value.per[id] || 0, unusable_value: (value.unusable_per || {})[id] || 0,
        allergens: f ? [...f.allergens] : [],
        allergen_flag: f ? f.allergens.some(a => avoid.has(a)) : false,
        expiring_flag: usableG > 0 && (state.batches || []).some(b =>
          b.food_id === id && ["near", "expired"].includes(batchesMod.batchStatus(b, today, batchesMod.nearDaysOf(state)).key)),
      };
    })
    .sort((a, b) => b.value - a.value || a.food_id.localeCompare(b.food_id));

  return {
    state,
    family_allergens: familyAllergens(state.members),
    today,
    near_days: batchesMod.nearDaysOf(state),
    shopping: currentItems(state)
      .map(it => decorateItem(state, it))
      .sort((a, b) => (a.status === b.status ? a.id - b.id : a.status === "arrived" ? 1 : -1)),
    stock,
    inventory_value: value.total,
    usable_inventory_value: value.usable_total,
    unusable_inventory_value: value.unusable_total,
    batches: Array.isArray(state.batches) ? batchesMod.batchListView(state, today) : [],
    batch_summary: Array.isArray(state.batches) ? batchesMod.batchSummary(state, today) : null,
    scraps: Array.isArray(state.scraps) ? state.scraps.filter(r => r.cycle === state.cycle_no)
      .map(r => ({ ...r, name: getFood(r.food_id) ? getFood(r.food_id).name : r.food_id,
        by_name: r.by != null ? (state.members.find(m => m.id === r.by) || {}).name || null : null }))
      .sort((a, b) => b.ts - a.ts) : [],
    budget: budgetSummary(state),
    sync: syncInputs(state),
    warnings: warnings(state, on),
    consumed_days: [...state.consumed_days],
    week: state.week,
    week_cycle: state.week ? state.week.cycle != null ? state.week.cycle : null : null,
    week_stale: !!(state.week && state.week.plan && !weekIsCurrent(state)),
  };
}

module.exports = {
  ROUND_G, SAFETY_FACTOR, MEMBER_ROLES,
  emptyHousehold, sanitizeProfile, familyAllergens,
  addMember, updateMember, removeMember,
  stockOnHand, usableStock, unusableStock, inventoryValue, budgetSummary,
  buildShoppingList, addManualItem, assignItem, removeItem, arriveItem,
  consume, consumeDay, setManualStock, setWeek, startNewCycle,
  weeklyUsed, syncInputs, warnings, householdView, weekIsCurrent,
  setClock, registerStockBatch, keepBatch, reviewScrapBatch,
  resyncShoppingAfterStockChange, setFamilyResyncHook,
  batches: batchesMod,
};

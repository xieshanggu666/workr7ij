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
    members: [],
    next_member_id: 1,
    shopping: [],           // {id, cycle, source:"menu"|"manual"|"family", food_id, grams, est_cost, assignee, status, arrived_grams, actual_cost, arrived_by}
    consumption: [],        // {id, cycle, food_id, grams, source:"plan"|"manual", day_index, member}
    stock_manual: {},       // 期初 / 盘库入库（非采购渠道）{food_id: grams}
    consumed_days: [],      // 当前周期已按配餐消耗的日序号
    week: null,             // 最近一次联动生成的周菜单 {cycle, params, plan}，cycle 为菜单所属采购周
    family_plan: null,      // 家庭分餐协作菜单（按成员营养目标生成，行级份量 / 替换 / 到货 / 消耗可追溯）
    next_item_id: 1,
    next_log_id: 1,
    next_line_id: 1,
    next_event_id: 1,
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

/* ---------------- 库存核算 ---------------- */

/* 在库库存（毛重克）= 历轮到货 + 期初盘库 - 全部消耗，截断为非负 */
function stockOnHand(state) {
  const map = {};
  for (const [id, g] of Object.entries(state.stock_manual || {})) map[id] = (map[id] || 0) + Number(g) || 0;
  for (const it of state.shopping) {
    if (it.status === "arrived") map[it.food_id] = (map[it.food_id] || 0) + (it.arrived_grams || 0);
  }
  for (const log of state.consumption) map[log.food_id] = (map[log.food_id] || 0) - log.grams;
  for (const id of Object.keys(map)) map[id] = Math.max(0, round1(map[id]));
  return map;
}

/* 库存估值：消耗优先抵减期初/盘库，剩余采购库存按实际加权均价计价 */
function inventoryValue(state, onHand) {
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
  const projected = round2(spent + committed);
  return {
    budget: round2(budget),
    spent,                       // 已实际采购支出
    price_delta: round2(spent - estSpent), // 实际价与预估偏差
    committed,                   // 待买预估占用
    projected,                   // 预计本周总支出
    remaining: round2(budget - projected),
    over: projected > budget,
  };
}

/* ---------------- 采购清单 ---------------- */

function assertFood(foodId) {
  const f = getFood(foodId);
  if (!f) throw new Error("未知食材：" + foodId);
  return f;
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
  const on = stockOnHand(state);

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
  if (it.status === "arrived") {
    /* 已到货任务被删除：其库存不再可追溯，提示调用方库存可能变化（核算自动重算） */
  }
  return it;
}

/* 确认到货：可登记实际克重与实际单价（元/100g），缺省按预估 */
function arriveItem(state, itemId, opts) {
  opts = opts || {};
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
  return it;
}

/* ---------------- 消耗 ---------------- */

function consume(state, input) {
  const f = assertFood(input.food_id);
  const grams = Math.round(Number(input.grams) * 10) / 10;
  if (!(grams > 0)) throw new Error("消耗克重必须为正数");
  const on = stockOnHand(state);
  if ((on[f.id] || 0) + 1e-6 < grams) {
    const err = new Error(`「${f.name}」库存不足：在库 ${on[f.id] || 0}g，消耗 ${grams}g`);
    err.code = "INSUFFICIENT_STOCK";
    err.deficit = { food_id: f.id, name: f.name, have: on[f.id] || 0, need: grams };
    throw err;
  }
  const log = {
    id: state.next_log_id++,
    cycle: state.cycle_no,
    food_id: f.id,
    grams,
    source: input.source === "plan" ? "plan" : "manual",
    day_index: Number.isInteger(input.day_index) ? input.day_index : null,
    member: input.member || null,
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
  const on = stockOnHand(state);
  const deficits = [];
  for (const [id, g] of Object.entries(need)) {
    if ((on[id] || 0) + 1e-6 < g) {
      const f = getFood(id);
      deficits.push({ food_id: id, name: f ? f.name : id, have: on[id] || 0, need: g, short: round1(g - (on[id] || 0)) });
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

/* 期初 / 盘库录入（允许录入含过敏原的存货，但会出现在规避预警中） */
function setManualStock(state, foodId, grams) {
  const f = assertFood(foodId);
  const g = Math.round(Number(grams) * 10) / 10;
  if (!(g >= 0)) throw new Error("克重非法");
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

/* 后续配餐输入：库存、过敏原并集、本周限次 */
function syncInputs(state) {
  return { allergens: familyAllergens(state.members), weekly_used: weeklyUsed(state), stock: stockOnHand(state) };
}

/* ---------------- 预警 ---------------- */

function warnings(state, onHand) {
  const on = onHand || stockOnHand(state);
  const avoid = familyAllergens(state.members);
  const out = [];

  for (const [id, g] of Object.entries(on)) {
    if (g <= 0) continue;
    const f = getFood(id);
    if (!f) continue;
    const hit = (f.allergens || []).filter(a => avoid.includes(a));
    if (hit.length) out.push({ level: "danger", code: "allergen_stock", text: `库存「${f.name}」含全家规避过敏原 ${hit.join("、")}，请勿用于家庭配餐` });
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

  /* 缺料预警仅针对本周期菜单；旧周菜单已过期，不再驱动新周期的采购提示 */
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
        out.push({ level: "warn", code: "shortage", text: `后续配餐缺料：${f ? f.name : id} 还需 ${roundUp(gap)}g（在库 ${on[id] || 0}g / 待买 ${pendingGrams[id] || 0}g）` });
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
  const value = inventoryValue(state, on);
  const avoid = new Set(familyAllergens(state.members));
  const stock = Object.entries(on)
    .filter(([, g]) => g > 0)
    .map(([id, g]) => {
      const f = getFood(id);
      return {
        food_id: id, name: f ? f.name : id, cat: f ? f.cat : "", cat_label: f ? f.cat_label || "" : "",
        grams: g, value: value.per[id] || 0,
        allergens: f ? [...f.allergens] : [],
        allergen_flag: f ? f.allergens.some(a => avoid.has(a)) : false,
      };
    })
    .sort((a, b) => b.value - a.value || a.food_id.localeCompare(b.food_id));

  return {
    state,
    family_allergens: familyAllergens(state.members),
    shopping: currentItems(state)
      .map(it => decorateItem(state, it))
      .sort((a, b) => (a.status === b.status ? a.id - b.id : a.status === "arrived" ? 1 : -1)),
    stock,
    inventory_value: value.total,
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
  stockOnHand, inventoryValue, budgetSummary,
  buildShoppingList, addManualItem, assignItem, removeItem, arriveItem,
  consume, consumeDay, setManualStock, setWeek, startNewCycle,
  weeklyUsed, syncInputs, warnings, householdView, weekIsCurrent,
};

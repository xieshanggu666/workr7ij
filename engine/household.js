"use strict";
/* 家庭采购与库存管理：
   1. 家庭成员维护过敏原，全家规避清单取并集（严格规避）；
   2. 基于周菜单按毛重聚合净需求（需求 - 在库 - 待买，含 10% 安全余量并按 10g 取整），
      生成采购清单并按成员当前负载分工；
   3. 确认到货（可登记实际克重与实际单价）后入库存并计入实际支出，含过敏原食材拦截；
   4. 按配餐 / 手动消耗扣减库存，并累计本周已用次数（供食材周限次约束使用）；
   5. 库存变化同步预算（已采购 / 待买 / 剩余）、过敏规避（在库致敏预警）与后续配餐
      （库存优先、零边际采购成本、weekly_used 限次）；
   6. 食材批次与保质期：采购到货 / 手动登记生成批次（生产日期 + 保质期至，缺省按类目保质天数推算），
      消耗按 FEFO（先到期先出）扣减批次；已失效批次不计入可用库存（配餐自动避开），
      临期批次预警供家长审核（继续用 / 报废），报废由家长确认后同步扣库存、记报废损失并生成替换采购。
   所有克重均与配餐一致，使用毛重（计价口径）。状态为纯数据对象，便于持久化与测试。 */

const { getFood, costFor, ALLERGENS, SHELF_DAYS, CATEGORY_LABEL } = require("./foods");
const { PROFILE_KEYS, ACTIVITY_KEYS, GOAL_KEYS } = require("./requirements");

const ROUND_G = 10;        // 采购克重取整步长
const SAFETY_FACTOR = 1.1; // 采购安全余量
const NEAR_EXPIRY_DAYS = 2; // 距保质期 ≤ 该天数视为临期（当天到期也算临期）

/* 家庭分餐协作角色：家长确认份量；成员确认替换；采购负责人确认到货。
   null / "any" 表示未指定角色（向后兼容，权限校验放行）。 */
const MEMBER_ROLES = { parent: "家长", member: "成员", buyer: "采购负责人" };

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }
function roundUp(g) { return Math.max(ROUND_G, Math.ceil((g - 1e-9) / ROUND_G) * ROUND_G); }

/* ---------------- 日期工具（批次保质期；均为本地日期 YYYY-MM-DD 字符串） ---------------- */

function pad2(n) { return String(n).padStart(2, "0"); }
function dateStr(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function todayStr() { return dateStr(new Date()); }
function assertDateStr(s, label) {
  const v = String(s == null ? "" : s).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v))) {
    throw new Error((label || "日期") + "格式应为 YYYY-MM-DD");
  }
  return v;
}
function addDaysStr(s, n) {
  const d = new Date(Date.parse(s));
  d.setUTCDate(d.getUTCDate() + n);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}
/* 距保质期天数：<0 已过期；0 当天到期；>0 剩余天数 */
function daysLeftOf(expiryOn, today) { return Math.round((Date.parse(expiryOn) - Date.parse(today)) / 86400000); }

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
    batches: [],            // 食材批次 {id, cycle, food_id, grams, remaining, source, shopping_id, produced_on, expiry_on, unit_cost, registered_by, registered_ts, reviewed_by, reviewed_ts, status}
    disposals: [],          // 报废记录 {id, cycle, batch_id, food_id, grams, value_loss, reason, by, ts}
    week: null,             // 最近一次联动生成的周菜单 {cycle, params, plan}，cycle 为菜单所属采购周
    family_plan: null,      // 家庭分餐协作菜单（按成员营养目标生成，行级份量 / 替换 / 到货 / 消耗可追溯）
    next_item_id: 1,
    next_log_id: 1,
    next_line_id: 1,
    next_event_id: 1,
    next_batch_id: 1,
    next_disposal_id: 1,
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

/* 角色权限（与 family.js 同一约定）：actor_id 缺省 => 系统 / 兼容调用，放行；
   指定时必须是家庭成员；其 role 为 null 视为未分工（放行），指定了角色则必须匹配。 */
function assertRole(state, actorId, role) {
  if (actorId == null) return;
  const actor = state.members.find(m => m.id === Number(actorId));
  if (!actor) throw new Error("操作人不是家庭成员");
  if (actor.role && actor.role !== role) {
    throw new Error(`仅${MEMBER_ROLES[role]}可执行此操作`);
  }
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

/* 在库库存（毛重克）= 历轮到货 + 期初盘库 - 全部消耗 - 报废出库，截断为非负 */
function stockOnHand(state) {
  const map = {};
  for (const [id, g] of Object.entries(state.stock_manual || {})) map[id] = (map[id] || 0) + Number(g) || 0;
  for (const it of state.shopping) {
    if (it.status === "arrived") map[it.food_id] = (map[it.food_id] || 0) + (it.arrived_grams || 0);
  }
  for (const log of state.consumption) map[log.food_id] = (map[log.food_id] || 0) - log.grams;
  for (const d of state.disposals || []) map[d.food_id] = (map[d.food_id] || 0) - d.grams;
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

/* ---------------- 食材批次与保质期 ---------------- */

const BATCH_STATUS_LABEL = { fresh: "正常", near: "临期", expired: "已过期", depleted: "已用完", disposed: "已报废" };

function activeBatches(state, foodId) {
  return (state.batches || []).filter(b => b.food_id === foodId && b.status !== "disposed" && b.remaining > 0);
}
function activeBatchGrams(state, foodId) {
  return round1(activeBatches(state, foodId).reduce((s, b) => s + b.remaining, 0));
}
function batchExpired(b, today) { return !!(b.expiry_on && b.expiry_on < today); }
function batchStatus(b, today) {
  if (b.status === "disposed") return "disposed";
  if (!(b.remaining > 0)) return "depleted";
  if (b.expiry_on) {
    const dl = daysLeftOf(b.expiry_on, today);
    if (dl < 0) return "expired";
    if (dl <= NEAR_EXPIRY_DAYS) return "near";
  }
  return "fresh";
}

/* 已失效（过期未报废）批次的剩余量 {food_id: grams}：仍在库但不可用于配餐与消耗 */
function expiredStock(state, today) {
  const t = today || todayStr();
  const map = {};
  for (const b of state.batches || []) {
    if (b.status === "disposed" || !(b.remaining > 0)) continue;
    if (batchExpired(b, t)) map[b.food_id] = round1((map[b.food_id] || 0) + b.remaining);
  }
  return map;
}

/* 可用库存 = 在库库存 - 已失效批次余量：配餐 / 消耗 / 净需求核算的统一口径（自动避开失效食材） */
function usableStock(state, today) {
  const on = stockOnHand(state);
  const exp = expiredStock(state, today);
  const out = {};
  for (const id of Object.keys(on)) out[id] = Math.max(0, round1((on[id] || 0) - (exp[id] || 0)));
  return out;
}

/* 批次保质期：显式 expiry_on 优先；否则按 生产日期（缺省登记当日）+ 类目默认保质天数推算 */
function resolveExpiry(food, input, today) {
  if (input.expiry_on) return assertDateStr(input.expiry_on, "保质期至");
  const shelf = SHELF_DAYS[food.cat];
  const base = input.produced_on ? assertDateStr(input.produced_on, "生产日期") : today;
  return shelf ? addDaysStr(base, shelf) : null;
}

function pushBatch(state, food, opts) {
  const b = {
    id: state.next_batch_id++,
    cycle: state.cycle_no,
    food_id: food.id,
    grams: round1(opts.grams),
    remaining: round1(opts.grams),
    source: opts.source === "arrival" ? "arrival" : "manual",
    shopping_id: opts.shopping_id != null ? opts.shopping_id : null,
    produced_on: opts.produced_on || null,
    expiry_on: opts.expiry_on || null,
    unit_cost: opts.unit_cost != null ? round2(opts.unit_cost) : food.cost,
    registered_by: opts.registered_by != null ? opts.registered_by : null,
    registered_ts: Date.now(),
    reviewed_by: null,
    reviewed_ts: null,
    status: "active",
  };
  state.batches.push(b);
  return b;
}

/* FEFO 扣减：消耗优先从最早到期的未失效批次出账，未批次化库存不落在批次账上 */
function allocateConsumption(state, foodId, grams, today) {
  let left = grams;
  const bs = activeBatches(state, foodId)
    .filter(b => !batchExpired(b, today))
    .sort((a, b) => {
      const ta = a.expiry_on ? Date.parse(a.expiry_on) : Infinity;
      const tb = b.expiry_on ? Date.parse(b.expiry_on) : Infinity;
      return ta - tb || a.id - b.id;
    });
  for (const b of bs) {
    if (left <= 1e-9) break;
    const take = Math.min(b.remaining, left);
    b.remaining = round1(b.remaining - take);
    left = round1(left - take);
  }
}

/* 盘库下调时冲减批次余量（先到期先冲），保持批次合计不超过在库 */
function trimBatches(state, foodId, grams) {
  let left = grams;
  const bs = activeBatches(state, foodId)
    .sort((a, b) => {
      const ta = a.expiry_on ? Date.parse(a.expiry_on) : Infinity;
      const tb = b.expiry_on ? Date.parse(b.expiry_on) : Infinity;
      return ta - tb || a.id - b.id;
    });
  for (const b of bs) {
    if (left <= 1e-9) break;
    const take = Math.min(b.remaining, left);
    b.remaining = round1(b.remaining - take);
    left = round1(left - take);
  }
}

/* 采购负责人登记批次：针对已在库但未批次化的库存（如冰箱现有食材）补登保质期 */
function registerBatch(state, input, actorId) {
  assertRole(state, actorId, "buyer");
  const f = assertFood(input.food_id);
  const grams = round1(Number(input.grams));
  if (!(grams > 0)) throw new Error("批次克重必须为正数");
  const today = input.today || todayStr();
  const on = stockOnHand(state);
  const avail = round1((on[f.id] || 0) - activeBatchGrams(state, f.id));
  if (grams - avail > 1e-6) {
    throw new Error(`「${f.name}」可登记批次的库存不足：未批次化余量 ${avail}g，登记 ${grams}g`);
  }
  return pushBatch(state, f, {
    grams,
    source: "manual",
    produced_on: input.produced_on ? assertDateStr(input.produced_on, "生产日期") : null,
    expiry_on: resolveExpiry(f, input, today),
    unit_cost: f.cost,
    registered_by: actorId == null ? null : Number(actorId),
  });
}

/* 家长审核临期批次：确认继续使用后临期预警不再重复提示（过期批次必须报废，不可审核留用） */
function reviewBatch(state, batchId, actorId, today) {
  const b = (state.batches || []).find(x => x.id === Number(batchId));
  if (!b) throw new Error("批次不存在");
  assertRole(state, actorId, "parent");
  const st = batchStatus(b, today || todayStr());
  if (st === "disposed") throw new Error("该批次已报废");
  if (st === "depleted") throw new Error("该批次已用完");
  if (st === "expired") throw new Error("批次已过期，请按报废处理");
  if (st !== "near") throw new Error("批次未临期，无需审核");
  b.reviewed_by = actorId == null ? null : Number(actorId);
  b.reviewed_ts = Date.now();
  return b;
}

/* 家长确认报废：批次剩余清零并出库（扣库存、记报废损失），同时生成替换采购项补齐库存。
   含全家过敏原的食材不生成替换项（避免再次买入规避食材）。 */
function disposeBatch(state, batchId, opts) {
  opts = opts || {};
  const b = (state.batches || []).find(x => x.id === Number(batchId));
  if (!b) throw new Error("批次不存在");
  assertRole(state, opts.actor_id, "parent");
  if (b.status === "disposed") throw new Error("该批次已报废");
  const grams = round1(b.remaining);
  if (!(grams > 0)) throw new Error("该批次已无剩余，无需报废");
  const today = opts.today || todayStr();
  const f = getFood(b.food_id);
  const unit = b.unit_cost != null ? b.unit_cost : (f ? f.cost : 0);
  const loss = round2((unit * grams) / 100);
  b.status = "disposed";
  b.remaining = 0;
  const disposal = {
    id: state.next_disposal_id++,
    cycle: state.cycle_no,
    batch_id: b.id,
    food_id: b.food_id,
    grams,
    value_loss: loss,
    reason: opts.reason || (batchExpired(b, today) ? "过期报废" : "变质报废"),
    by: opts.actor_id == null ? null : Number(opts.actor_id),
    ts: Date.now(),
  };
  state.disposals.push(disposal);

  let replacement = null;
  const allergenHit = f && (f.allergens || []).some(a => familyAllergens(state.members).includes(a));
  if (f && !allergenHit) {
    const rg = roundUp(grams);
    replacement = {
      id: state.next_item_id++,
      cycle: state.cycle_no,
      source: "replace",
      food_id: b.food_id,
      grams: rg,
      est_cost: round2(costFor(f, rg)),
      assignee: leastLoadedMember(state),
      status: "pending",
      arrived_grams: 0,
      actual_cost: 0,
      ref_batch_id: b.id,
    };
    state.shopping.push(replacement);
  }
  return { batch: b, disposal, replacement };
}

/* 批次视图：按 已过期 > 临期 > 正常 > 已用完 > 已报废 排序，同状态按到期先后 */
function batchList(state, today) {
  const t = today || todayStr();
  const rank = { expired: 0, near: 1, fresh: 2, depleted: 3, disposed: 4 };
  return (state.batches || []).map(b => {
    const f = getFood(b.food_id);
    const st = batchStatus(b, t);
    const unit = b.unit_cost != null ? b.unit_cost : (f ? f.cost : 0);
    return {
      ...b,
      name: f ? f.name : b.food_id,
      cat_label: f ? CATEGORY_LABEL[f.cat] || "" : "",
      freshness: st,
      status_label: BATCH_STATUS_LABEL[st],
      days_left: b.expiry_on ? daysLeftOf(b.expiry_on, t) : null,
      value: round2((b.remaining * unit) / 100),
      source_label: b.source === "arrival" ? "采购到货" : "手动登记",
      registered_by_name: b.registered_by != null ? (state.members.find(m => m.id === b.registered_by) || {}).name || null : null,
      reviewed_by_name: b.reviewed_by != null ? (state.members.find(m => m.id === b.reviewed_by) || {}).name || null : null,
    };
  }).sort((a, b) => {
    const ra = rank[batchStatus(a, t)], rb = rank[batchStatus(b, t)];
    if (ra !== rb) return ra - rb;
    const da = a.days_left == null ? Infinity : a.days_left;
    const db = b.days_left == null ? Infinity : b.days_left;
    return da - db || a.id - b.id;
  });
}

function disposalList(state) {
  return (state.disposals || []).slice().sort((a, b) => b.ts - a.ts || b.id - a.id).map(d => {
    const f = getFood(d.food_id);
    return {
      ...d,
      name: f ? f.name : d.food_id,
      by_name: d.by != null ? (state.members.find(m => m.id === d.by) || {}).name || null : null,
    };
  });
}

/* ---------------- 预算 ---------------- */

function budgetSummary(state) {
  const budget = Number(state.weekly_budget) || 0;
  const items = state.shopping.filter(i => i.cycle === state.cycle_no);
  const spent = round2(items.filter(i => i.status === "arrived").reduce((s, i) => s + (i.actual_cost || 0), 0));
  const estSpent = round2(items.filter(i => i.status === "arrived").reduce((s, i) => s + (i.est_cost || 0), 0));
  const committed = round2(items.filter(i => i.status === "pending").reduce((s, i) => s + (i.est_cost || 0), 0));
  const projected = round2(spent + committed);
  const waste = (state.disposals || []).filter(d => d.cycle === state.cycle_no);
  return {
    budget: round2(budget),
    spent,                       // 已实际采购支出
    price_delta: round2(spent - estSpent), // 实际价与预估偏差
    committed,                   // 待买预估占用（含报废替换采购）
    projected,                   // 预计本周总支出
    remaining: round2(budget - projected),
    over: projected > budget,
    waste_loss: round2(waste.reduce((s, d) => s + (d.value_loss || 0), 0)),  // 本周报废损失（已含在已采购支出中，单独列示）
    waste_grams: round1(waste.reduce((s, d) => s + d.grams, 0)),
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
  const on = usableStock(state, opts.today);

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

/* 确认到货：可登记实际克重与实际单价（元/100g），缺省按预估；
   同时登记食材批次（生产日期 / 保质期至，缺省按类目保质天数推算），由采购负责人经手 */
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
  const today = opts.today || todayStr();
  const batch = pushBatch(state, f, {
    grams,
    source: "arrival",
    shopping_id: it.id,
    produced_on: opts.produced_on ? assertDateStr(opts.produced_on, "生产日期") : null,
    expiry_on: resolveExpiry(f, opts, today),
    unit_cost: unitCost,
    registered_by: it.arrived_by != null ? it.arrived_by : null,
  });
  it.batch_id = batch.id;
  return it;
}

/* ---------------- 消耗 ---------------- */

function consume(state, input) {
  const f = assertFood(input.food_id);
  const grams = Math.round(Number(input.grams) * 10) / 10;
  if (!(grams > 0)) throw new Error("消耗克重必须为正数");
  const today = input.today || todayStr();
  const on = usableStock(state, today);
  const expired = expiredStock(state, today)[f.id] || 0;
  if ((on[f.id] || 0) + 1e-6 < grams) {
    const err = new Error(`「${f.name}」可用库存不足：可用 ${on[f.id] || 0}g${expired > 0 ? `（另有已失效 ${expired}g 待家长审核报废）` : ""}，消耗 ${grams}g`);
    err.code = "INSUFFICIENT_STOCK";
    err.deficit = { food_id: f.id, name: f.name, have: on[f.id] || 0, expired, need: grams };
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
  allocateConsumption(state, f.id, grams, today);
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
function consumeDay(state, dayIndex, today) {
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
  const on = usableStock(state, today);
  const deficits = [];
  for (const [id, g] of Object.entries(need)) {
    if ((on[id] || 0) + 1e-6 < g) {
      const f = getFood(id);
      deficits.push({ food_id: id, name: f ? f.name : id, have: on[id] || 0, need: g, short: round1(g - (on[id] || 0)) });
    }
  }
  if (deficits.length) {
    const err = new Error("可用库存不足，请先确认采购到货或处理失效批次：" + deficits.map(d => `${d.name}缺${d.short}g`).join("；"));
    err.code = "INSUFFICIENT_STOCK";
    err.deficits = deficits;
    throw err;
  }
  const logs = [];
  for (const [id, g] of Object.entries(need)) {
    logs.push(consume(state, { food_id: id, grams: g, source: "plan", day_index: dayIndex, today }));
  }
  state.consumed_days.push(dayIndex);
  state.consumed_days.sort((a, b) => a - b);
  return logs;
}

/* 期初 / 盘库录入（允许录入含过敏原的存货，但会出现在规避预警中）；
   增量时附带生产日期 / 保质期至会同步登记批次；下调时先冲减未批次化库存，再按到期先后冲减批次 */
function setManualStock(state, foodId, grams, opts) {
  opts = opts || {};
  const f = assertFood(foodId);
  const g = Math.round(Number(grams) * 10) / 10;
  if (!(g >= 0)) throw new Error("克重非法");
  const old = state.stock_manual[f.id] || 0;
  if (g === 0) delete state.stock_manual[f.id];
  else state.stock_manual[f.id] = g;
  const delta = round1(g - old);
  const today = opts.today || todayStr();
  if (delta > 0 && (opts.expiry_on || opts.produced_on)) {
    pushBatch(state, f, {
      grams: delta,
      source: "manual",
      produced_on: opts.produced_on ? assertDateStr(opts.produced_on, "生产日期") : null,
      expiry_on: resolveExpiry(f, opts, today),
      unit_cost: f.cost,
      registered_by: opts.actor_id != null ? Number(opts.actor_id) : null,
    });
  } else if (delta < 0) {
    const on = stockOnHand(state);
    const overflow = round1(activeBatchGrams(state, f.id) - (on[f.id] || 0));
    if (overflow > 0) trimBatches(state, f.id, overflow);
  }
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

/* 后续配餐输入：可用库存（已排除失效批次，配餐自动避开失效食材）、过敏原并集、本周限次 */
function syncInputs(state, today) {
  return { allergens: familyAllergens(state.members), weekly_used: weeklyUsed(state), stock: usableStock(state, today) };
}

/* ---------------- 预警 ---------------- */

function warnings(state, onHand, today) {
  const t = today || todayStr();
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

  /* 批次保质期：已过期（配餐已自动避开，待家长审核报废）与临期（优先使用，家长可审核留用） */
  for (const b of state.batches || []) {
    if (b.status === "disposed" || !(b.remaining > 0)) continue;
    const st = batchStatus(b, t);
    if (st === "expired") {
      const f = getFood(b.food_id);
      out.push({ level: "danger", code: "batch_expired", text: `「${f ? f.name : b.food_id}」批次#${b.id} 已于 ${b.expiry_on} 过期（剩余 ${b.remaining}g），配餐与消耗已自动避开，请家长审核报废` });
    } else if (st === "near" && !b.reviewed_ts) {
      const f = getFood(b.food_id);
      const dl = daysLeftOf(b.expiry_on, t);
      out.push({ level: "warn", code: "batch_near", text: `「${f ? f.name : b.food_id}」批次#${b.id} ${dl === 0 ? "今天到期" : `将于 ${b.expiry_on} 到期（${dl} 天后）`}，剩余 ${b.remaining}g，请优先使用；如已变质请家长报废` });
    }
  }

  const budget = budgetSummary(state);
  if (budget.over) {
    out.push({ level: "danger", code: "budget_over", text: `本周预计支出 ¥${budget.projected} 超出预算 ¥${budget.budget}，超支 ¥${round2(-budget.remaining)}` });
  }

  /* 缺料预警仅针对本周期菜单；旧周菜单已过期，不再驱动新周期的采购提示 */
  if (weekIsCurrent(state)) {
    const usable = usableStock(state, t);
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
      const gap = g - (usable[id] || 0) - (pendingGrams[id] || 0);
      if (gap > 1e-6) {
        const f = getFood(id);
        out.push({ level: "warn", code: "shortage", text: `后续配餐缺料：${f ? f.name : id} 还需 ${roundUp(gap)}g（可用 ${usable[id] || 0}g / 待买 ${pendingGrams[id] || 0}g）` });
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
    source_label: it.source === "family" ? "分餐" : it.source === "manual" ? "手动" : it.source === "replace" ? "替换补货" : "周菜单",
    allergens: f ? [...f.allergens] : [],
    allergen_flag: f ? f.allergens.some(a => avoid.has(a)) : false,
    assignee_name: it.assignee != null ? (state.members.find(m => m.id === it.assignee) || {}).name : null,
    arrived_by_name: it.arrived_by != null ? (state.members.find(m => m.id === it.arrived_by) || {}).name : null,
  };
}

function householdView(state, today) {
  const t = today || todayStr();
  const on = stockOnHand(state);
  const usable = usableStock(state, t);
  const expired = expiredStock(state, t);
  const value = inventoryValue(state, on);
  const avoid = new Set(familyAllergens(state.members));
  const stock = Object.entries(on)
    .filter(([, g]) => g > 0)
    .map(([id, g]) => {
      const f = getFood(id);
      return {
        food_id: id, name: f ? f.name : id, cat: f ? f.cat : "", cat_label: f ? f.cat_label || "" : "",
        grams: g, usable_grams: usable[id] || 0, expired_grams: expired[id] || 0, value: value.per[id] || 0,
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
    batches: batchList(state, t),
    disposals: disposalList(state),
    budget: budgetSummary(state),
    sync: syncInputs(state, t),
    warnings: warnings(state, on, t),
    consumed_days: [...state.consumed_days],
    week: state.week,
    week_cycle: state.week ? state.week.cycle != null ? state.week.cycle : null : null,
    week_stale: !!(state.week && state.week.plan && !weekIsCurrent(state)),
  };
}

module.exports = {
  ROUND_G, SAFETY_FACTOR, MEMBER_ROLES, NEAR_EXPIRY_DAYS, BATCH_STATUS_LABEL,
  emptyHousehold, sanitizeProfile, familyAllergens,
  addMember, updateMember, removeMember,
  stockOnHand, usableStock, expiredStock, inventoryValue, budgetSummary,
  buildShoppingList, addManualItem, assignItem, removeItem, arriveItem,
  consume, consumeDay, setManualStock, setWeek, startNewCycle,
  registerBatch, reviewBatch, disposeBatch, batchStatus, batchList, disposalList,
  weeklyUsed, syncInputs, warnings, householdView, weekIsCurrent,
  todayStr, addDaysStr,
};

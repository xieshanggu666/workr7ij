"use strict";
/* 家庭分餐协作：
   1. 按每个成员的营养目标（年龄性别分层 / 活动水平 / 膳食目标）分别生成一周菜单，
      每餐每个槽位生成“分餐行”，初始份量为引擎求解克重——家长逐行 / 逐日 / 整周确认份量，可改克重；
   2. 成员对自己的分餐行发起替换（同槽位、不过敏、不撞忌口、不违反周限次，在库优先 / 更便宜优先），
      替换后该成员当日份量状态回退为待家长确认（替换记录全程留痕）；
   3. 采购负责人确认到货（复用采购库存到货，登记实际克重 / 实际单价 / 到货人）；
   4. 全部成员当日份量确认、所需食材在库齐备后，按日确认分餐消耗，逐行扣库存、记实际克重；
   5. 分餐菜单聚合净需求同步采购清单与预算，库存优先零边际成本，过敏限制取全家并集 + 成员忌口双重拦截；
   6. 所有行保留份量历史、替换历史、到货与消耗日志，按成员 / 食材双向可追溯。 */

const { getFood, costFor } = require("./foods");
const { getRequirement } = require("./requirements");
const { planDay, totalOf, SLOT_TABLE } = require("./constraints");
const { buildDayPools } = require("./menu");
const hh = require("./household");

const MEAL_LABEL = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐" };
const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }
function nowStamp() { return Date.now(); }

function familyCurrent(state) {
  const fp = state.family_plan;
  return !!(fp && fp.cycle === state.cycle_no);
}
function assertCurrent(state) {
  if (!state.family_plan) throw new Error("尚未生成分餐菜单");
  if (!familyCurrent(state)) {
    const err = new Error(
      `该分餐菜单属于第 ${state.family_plan.cycle} 采购周，当前为第 ${state.cycle_no} 周：旧菜单仅可追溯，请重新生成本周分餐菜单`
    );
    err.code = "STALE_WEEK";
    throw err;
  }
}
function memberById(state, id) {
  return state.members.find(m => m.id === id) || null;
}
function assertMember(state, id) {
  const m = memberById(state, Number(id));
  if (!m) throw new Error("成员不存在：" + id);
  return m;
}

/* ---------------- 角色权限 ----------------
   actor_id 缺省 => 系统 / 兼容调用，放行；
   指定时：该 id 必须是家庭成员；其 role 为 null/any 视为未分工（放行），
   指定了角色则必须匹配所需角色；本人操作（self_member_id）还需是本人。 */
function assertRole(state, actorId, role, selfMemberId) {
  if (actorId == null) return;
  const actor = memberById(state, Number(actorId));
  if (!actor) throw new Error("操作人不是家庭成员");
  if (selfMemberId != null && actor.id !== Number(selfMemberId)) {
    throw new Error("只能操作自己的分餐，请由本人确认");
  }
  if (actor.role && actor.role !== role) {
    throw new Error(`仅${role === "parent" ? "家长" : role === "buyer" ? "采购负责人" : "成员"}可执行此操作`);
  }
}

/* ---------------- 生成 ---------------- */

/* 周限次计数：已消耗日志 + 当前分餐菜单有效行（计划占用），保证替换不会突破周限次 */
function plannedWeeklyUsed(state) {
  const counts = hh.weeklyUsed(state);
  const fp = state.family_plan;
  if (fp) {
    for (const ln of fp.lines) {
      if (ln.status === "dropped") continue;
      counts[ln.food_id] = (counts[ln.food_id] || 0) + 1;
    }
  }
  return counts;
}

/* 分餐菜单当前有效行聚合的食材净需求（毛重克） */
function familyNeed(state, fp0) {
  const fp = fp0 || state.family_plan;
  const need = {};
  if (!fp) return need;
  for (const ln of fp.lines) {
    if (ln.status === "dropped") continue;
    need[ln.food_id] = round1((need[ln.food_id] || 0) + ln.grams);
  }
  return need;
}

/* 在库 + 待买能否覆盖分餐净需求（采购齐备口径），返回缺料明细；day_index 可只看某日。
   在库只计未过期 / 未报废批次：失效食材成员配餐自动避开，缺口进入替换采购。 */
function familyDeficits(state, fp0, dayIndex) {
  const fp = fp0 || state.family_plan;
  const on = hh.usableStock(state);
  const pendingGrams = {};
  for (const it of state.shopping) {
    if (it.cycle === state.cycle_no && it.status === "pending") {
      pendingGrams[it.food_id] = (pendingGrams[it.food_id] || 0) + it.grams;
    }
  }
  const need = {};
  for (const ln of fp.lines) {
    if (ln.status === "dropped") continue;
    if (dayIndex != null && ln.day !== dayIndex) continue;
    need[ln.food_id] = (need[ln.food_id] || 0) + ln.grams;
  }
  const deficits = [];
  for (const [id, g] of Object.entries(need)) {
    if ((on[id] || 0) + (pendingGrams[id] || 0) + 1e-6 < g) {
      const f = getFood(id);
      deficits.push({ food_id: id, name: f ? f.name : id, have: on[id] || 0, pending: pendingGrams[id] || 0, need: round1(g), short: round1(g - (on[id] || 0) - (pendingGrams[id] || 0)) });
    }
  }
  return deficits;
}

/* 库存实际可扣（不含待买，且剔除失效批次）口径：按日消耗前校验 */
function familyStockDeficits(state, dayIndex) {
  const fp = state.family_plan;
  const on = hh.usableStock(state);
  const need = {};
  for (const ln of fp.lines) {
    if (ln.status === "dropped") continue;
    if (ln.day !== dayIndex) continue;
    need[ln.food_id] = (need[ln.food_id] || 0) + ln.grams;
  }
  const deficits = [];
  for (const [id, g] of Object.entries(need)) {
    if ((on[id] || 0) + 1e-6 < g) {
      const f = getFood(id);
      const physical = hh.stockOnHand(state)[id] || 0;
      deficits.push({ food_id: id, name: f ? f.name : id, have: on[id] || 0, physical, need: round1(g), short: round1(g - (on[id] || 0)) });
    }
  }
  return deficits;
}

function buildFamilyPlan(state, input) {
  input = input || {};
  if (!state.members.length) throw new Error("请先添加家庭成员");
  const ids = (input.member_ids && input.member_ids.length ? input.member_ids : state.members.map(m => m.id)).map(Number);
  if (!ids.length) throw new Error("未选择任何成员");
  for (const id of ids) assertMember(state, id);
  const unique = [...new Set(ids)];
  /* 已有当日分餐消耗入账后不允许重建（保证可追溯）；未消耗可重建覆盖 */
  if (familyCurrent(state) && (state.family_plan.consumed_days || []).length) {
    throw new Error("本周已有分餐消耗入账，不能重新生成菜单；如需调整请使用成员替换或开启新采购周");
  }

  const familyAvoid = new Set(hh.familyAllergens(state.members));
  const sync = hh.syncInputs(state);
  const stockLive = { ...(sync.stock || {}) };       // 库存逐成员、逐日结转
  const weeklyUsed = { ...(sync.weekly_used || {}) };
  const lines = [];
  const memberDays = {};

  /* 先落地一个空计划，后续事件可写入 */
  const createdTs = nowStamp();
  state.family_plan = {
    cycle: state.cycle_no,
    created_ts: createdTs,
    member_ids: unique,
    lines: [],
    member_days: {},
    consumed_days: [],
    events: [],
    est_purchase_cost: 0,
  };
  const fp = state.family_plan;

  for (const memberId of unique) {
    const member = assertMember(state, memberId);
    const memberExclude = new Set([...(input.exclude || []), ...(member.exclude || [])]);
    const allergens = new Set([...familyAvoid, ...(member.allergens || [])]);
    memberDays[memberId] = {};

    for (let d = 0; d < 7; d++) {
      const dayPools = buildDayPools(d, {});
      const result = planDay({
        profile: member.profile,
        allergens: [...allergens],
        exclude: [...memberExclude],
        weekly_used: weeklyUsed,
        day_pools: dayPools,
        stock: stockLive,
      });
      if (!result.items.length) {
        throw new Error(`「${member.name}」在${DAY_NAMES[d]}无可用配餐：过敏原或忌口覆盖全部候选食材`);
      }
      for (const it of result.items) {
        weeklyUsed[it.food_id] = (weeklyUsed[it.food_id] || 0) + 1;
        const g = Math.round(it.grams * 10) / 10;
        lines.push({
          id: state.next_line_id++,
          member_id: memberId,
          day: d,
          meal: it.meal,
          role: it.role,
          food_id: it.food_id,
          grams: g,
          planned_grams: g,
          status: "pending",                // pending（待家长确认份量）
          portion_by: null, portion_ts: null,
          grams_history: [{ grams: g, by: null, ts: createdTs, note: "引擎按营养目标生成" }],
          substitutions: [],
          consumed_grams: null,
          consumed_ts: null,
          feasible: result.feasible,
          reasons: result.reasons || [],
        });
      }
      /* 当日求解后扣减共享库存，结转到下一成员 / 下一天 */
      const used = {};
      for (const it of result.items) used[it.food_id] = (used[it.food_id] || 0) + it.grams;
      for (const [id, g] of Object.entries(used)) {
        stockLive[id] = Math.max(0, (stockLive[id] || 0) - g);
        if (stockLive[id] < 0.05) stockLive[id] = 0;
      }
      memberDays[memberId][d] = { portion_status: "pending", substitute_status: "pending" };
    }
  }

  fp.lines = lines;
  fp.member_days = memberDays;

  /* 聚合分餐净需求 -> 同步采购清单（库存 / 待买抵扣 + 安全余量 + 负载分工）与预算 */
  resyncFamilyShopping(state);

  fp.events.push({ id: state.next_event_id++, ts: createdTs, kind: "plan_built", by: null, member_ids: unique, note: input.note || "按成员营养目标生成分餐菜单" });
  return familyView(state);
}

/* 分餐来源待买预估额（同步预算口径） */
function familyPurchaseEstimate(state) {
  return round2(state.shopping
    .filter(i => i.cycle === state.cycle_no && i.source === "family" && i.status === "pending")
    .reduce((s, i) => s + (i.est_cost || 0), 0));
}

/* 分餐变更后：刷新采购清单与预估额 */
function resyncFamilyShopping(state) {
  const fp = state.family_plan;
  if (!fp) return;
  const pseudoWeek = { days: [{ items: Object.entries(familyNeed(state, fp)).map(([food_id, grams]) => ({ food_id, grams })) }] };
  hh.buildShoppingList(state, pseudoWeek, { source: "family" });
  fp.est_purchase_cost = familyPurchaseEstimate(state);
}

function findLine(state, lineId) {
  const ln = state.family_plan.lines.find(x => x.id === Number(lineId));
  if (!ln) throw new Error("分餐行不存在");
  return ln;
}

/* ---------------- 家长确认份量 ---------------- */

function setLineGrams(state, lineId, grams, actorId, note) {
  assertCurrent(state);
  assertRole(state, actorId, "parent");
  const fp = state.family_plan;
  const ln = findLine(state, lineId);
  const g = Math.round(Number(grams) * 10) / 10;
  if (!(g > 0)) throw new Error("份量必须为正数");
  if (fp.consumed_days.includes(ln.day)) throw new Error("该日已消耗入账，份量不可再改");
  ln.grams = g;
  ln.status = "pending";
  ln.portion_by = null;
  ln.portion_ts = null;
  ln.grams_history.push({ grams: g, by: actorId == null ? null : Number(actorId), ts: nowStamp(), note: note || "家长调整份量" });
  fp.member_days[ln.member_id][ln.day].portion_status = "pending";
  fp.events.push({ id: state.next_event_id++, ts: nowStamp(), kind: "portion_edit", by: actorId == null ? null : Number(actorId), line_id: ln.id, member_id: ln.member_id, day: ln.day, grams: g });
  resyncFamilyShopping(state);
  return familyView(state);
}

/* 批量确认份量：scope=all 全周；scope=day 某日全部成员；scope=member_day 某成员某日；scope=line 单行 */
function confirmPortions(state, input, actorId) {
  assertCurrent(state);
  assertRole(state, actorId, "parent");
  input = input || {};
  const fp = state.family_plan;
  const scope = input.scope || "all";
  const match = (ln) => {
    if (ln.status === "dropped") return false;
    if (scope === "line") return ln.id === Number(input.line_id);
    if (scope === "day") return ln.day === Number(input.day);
    if (scope === "member_day") return ln.member_id === Number(input.member_id) && ln.day === Number(input.day);
    return true;
  };
  const targets = fp.lines.filter(match);
  if (!targets.length) throw new Error("没有可确认的分餐行");
  const ts = nowStamp();
  const touched = new Set();
  for (const ln of targets) {
    if (fp.consumed_days.includes(ln.day)) continue;
    ln.status = "confirmed";
    ln.portion_by = actorId == null ? null : Number(actorId);
    ln.portion_ts = ts;
    ln.grams_history.push({ grams: ln.grams, by: ln.portion_by, ts, note: "家长确认份量" });
    touched.add(ln.member_id + ":" + ln.day);
  }
  for (const key of touched) {
    const [mk, dk] = key.split(":").map(Number);
    const pending = fp.lines.some(l => l.member_id === mk && l.day === dk && l.status === "pending" && !fp.consumed_days.includes(dk));
    fp.member_days[mk][dk].portion_status = pending ? "pending" : "confirmed";
  }
  fp.events.push({ id: state.next_event_id++, ts, kind: "portion_confirm", by: actorId == null ? null : Number(actorId), scope, day: input.day == null ? null : Number(input.day), member_id: input.member_id == null ? null : Number(input.member_id), count: targets.length });
  return familyView(state);
}

/* ---------------- 成员替换 ---------------- */

const POOL_FORCE_KEYS = {
  staple: { breakfast: "breakfast_staple", lunch: "lunch_staple", dinner: "dinner_staple" },
  dairy_egg: { breakfast: "dairy_egg" },
  fruit: { breakfast: "fruit" },
  protein: { lunch: "lunch_protein", dinner: "dinner_protein" },
  veg_a: { lunch: "veg", dinner: "veg" },
  veg_b: { lunch: "veg", dinner: "veg" },
  oil: { lunch: "oil", dinner: "oil" },
  nut: { breakfast: "nut" },
};

/* 同槽位候选：当前食材之外、通过过敏 / 忌口 / 周限次，在库优先、其次更便宜 */
function substituteOptions(state, lineId, actorId) {
  assertCurrent(state);
  const fp = state.family_plan;
  const ln = findLine(state, lineId);
  if (fp.consumed_days.includes(ln.day)) throw new Error("该日已消耗入账，不能替换");
  assertRole(state, actorId, "member", ln.member_id);
  const member = assertMember(state, ln.member_id);
  const tableKey = ln.meal === "breakfast" && ln.role === "nut" ? "snack" : ln.meal;
  const slot = (SLOT_TABLE[tableKey] || []).find(s => s.role === ln.role);
  if (!slot) throw new Error("该分餐行无可替换槽位");
  const avoid = new Set([...hh.familyAllergens(state.members), ...(member.allergens || [])]);
  const exclude = new Set([...(member.exclude || [])]);
  /* 同一天内该成员其余行已用食材不重复 */
  for (const other of fp.lines) {
    if (other.member_id === ln.member_id && other.day === ln.day && other.id !== ln.id && other.status !== "dropped") exclude.add(other.food_id);
  }
  const used = plannedWeeklyUsed(state);
  const on = hh.usableStock(state);
  const cur = getFood(ln.food_id);
  const options = slot.pool.map(getFood).filter(Boolean).filter(f => f.id !== ln.food_id)
    .filter(f => !f.allergens.some(a => avoid.has(a)))
    .filter(f => !exclude.has(f.id))
    .filter(f => !f.weekly_limit || (used[f.id] || 0) < f.weekly_limit)
    .map(f => ({ food_id: f.id, name: f.name, cost: f.cost, in_stock: on[f.id] || 0, est_cost: round2(costFor(f, ln.grams)) }))
    .sort((a, b) => Number(b.in_stock > 0) - Number(a.in_stock > 0) || a.cost - b.cost || a.food_id.localeCompare(b.food_id));
  return { line: lineView(state, ln), current: { food_id: cur.id, name: cur.name, cost: cur.cost }, options };
}

/* 强制该槽位为目标食材重算当日，保证替换后营养目标仍尽量满足、份量与其余行协调 */
function replanMemberDay(state, member, dayIndex, forced) {
  const dayPools = Object.assign(buildDayPools(dayIndex, {}), { __force: forced || null });
  return planDay({
    profile: member.profile,
    allergens: [...new Set([...hh.familyAllergens(state.members), ...(member.allergens || [])])],
    exclude: member.exclude || [],
    weekly_used: plannedWeeklyUsed(state),
    day_pools: dayPools,
    stock: hh.usableStock(state),
  });
}

/* 成员确认替换：默认取首选，也可指定 target_food_id */
function substituteLine(state, lineId, input, actorId) {
  input = input || {};
  const opts = substituteOptions(state, lineId, actorId);
  const fp = state.family_plan;
  const ln = findLine(state, lineId);
  const targetId = input.target_food_id || (opts.options[0] && opts.options[0].food_id);
  if (!targetId) throw new Error("没有符合过敏、忌口与周限次要求的替换食材");
  const target = opts.options.find(o => o.food_id === targetId);
  if (!target) throw new Error("所选替换食材不可用（过敏原 / 忌口 / 周限次）");

  const member = assertMember(state, ln.member_id);
  const forceKey = (POOL_FORCE_KEYS[ln.role] || {})[ln.meal];
  if (!forceKey) throw new Error("该分餐行不支持替换");
  const replanned = replanMemberDay(state, member, ln.day, { [forceKey]: [targetId] });
  const newItem = replanned.items.find(i => i.meal === ln.meal && i.role === ln.role);
  if (!newItem || newItem.food_id !== targetId) {
    throw new Error("替换失败：目标食材在该日约束下无法入选");
  }

  const oldFood = ln.food_id;
  const ts = nowStamp();
  /* 按重算结果同步该成员当日其余行（食材 / 克重可能被引擎联动调整），并逐行留痕 */
  for (const it of replanned.items) {
    const peer = fp.lines.find(x => x.member_id === ln.member_id && x.day === ln.day && x.meal === it.meal && x.role === it.role && x.status !== "dropped");
    if (!peer) continue;
    const changedFood = peer.food_id !== it.food_id;
    const changedGrams = Math.abs(peer.grams - it.grams) > 1e-6;
    if (!changedFood && !changedGrams) continue;
    if (changedFood) {
      peer.substitutions.push({ from: peer.food_id, to: it.food_id, grams: Math.round(it.grams * 10) / 10, by: Number(actorId), ts, reason: "成员替换联动重排" });
    }
    peer.food_id = it.food_id;
    peer.grams = Math.round(it.grams * 10) / 10;
    peer.status = "pending";
    peer.portion_by = null;
    peer.portion_ts = null;
    peer.grams_history.push({ grams: peer.grams, by: null, ts, note: changedFood ? "替换联动重排" : "替换后营养重算" });
  }

  const targetLine = fp.lines.find(x => x.member_id === ln.member_id && x.day === ln.day && x.meal === ln.meal && x.role === ln.role);
  targetLine.substitutions.push({ from: oldFood, to: targetId, grams: targetLine.grams, by: Number(actorId), ts, reason: input.reason || "成员申请替换" });
  /* 替换 = 成员本人对替换的确认；份量回退待家长重新确认 */
  fp.member_days[ln.member_id][ln.day].substitute_status = "confirmed";
  fp.member_days[ln.member_id][ln.day].portion_status = "pending";
  fp.events.push({
    id: state.next_event_id++, ts, kind: "substitute",
    by: Number(actorId), line_id: ln.id, member_id: ln.member_id, day: ln.day,
    from: oldFood, to: targetId, reason: input.reason || null,
  });
  resyncFamilyShopping(state);
  return familyView(state);
}

/* ---------------- 到货（采购负责人） ---------------- */

function arriveFamilyItem(state, itemId, opts, actorId) {
  assertCurrent(state);
  assertRole(state, actorId, "buyer");
  const it = state.shopping.find(x => x.id === Number(itemId) && x.cycle === state.cycle_no);
  if (!it) throw new Error("采购任务不存在");
  const arrived = hh.arriveItem(
    state, it.id,
    Object.assign({}, opts, { arrived_by: actorId == null ? undefined : Number(actorId) }),
    actorId,
  );
  state.family_plan.events.push({ id: state.next_event_id++, ts: nowStamp(), kind: "arrive", by: actorId == null ? null : Number(actorId), shopping_id: it.id, food_id: it.food_id, grams: arrived.arrived_grams, actual_cost: arrived.actual_cost, expire_date: opts.expire_date || null });
  return familyView(state);
}

/* ---------------- 按日分餐消耗 ---------------- */

function familyDayReady(state, dayIndex) {
  const fp = state.family_plan;
  const perMember = [];
  let allConfirmed = true;
  for (const mid of fp.member_ids) {
    const lines = fp.lines.filter(l => l.member_id === mid && l.day === dayIndex && l.status !== "dropped");
    const confirmed = lines.length > 0 && lines.every(l => l.status === "confirmed");
    if (!confirmed) allConfirmed = false;
    const m = memberById(state, mid);
    perMember.push({ member_id: mid, name: m ? m.name : "（已删除）", lines: lines.length, confirmed });
  }
  const stockDeficits = familyStockDeficits(state, dayIndex);
  return { all_confirmed: allConfirmed, members: perMember, stock_deficits: stockDeficits, ready: allConfirmed && !stockDeficits.length };
}

function consumeFamilyDay(state, dayIndex, actorId) {
  assertCurrent(state);
  assertRole(state, actorId, "parent");
  const fp = state.family_plan;
  dayIndex = Number(dayIndex);
  if (!(dayIndex >= 0 && dayIndex < 7)) throw new Error("日期序号非法");
  if (fp.consumed_days.includes(dayIndex)) throw new Error("该日分餐已确认消耗");
  const ready = familyDayReady(state, dayIndex);
  if (!ready.all_confirmed) {
    const who = ready.members.filter(x => !x.confirmed).map(x => x.name).join("、");
    throw new Error(`仍有成员当日份量未经家长确认：${who}`);
  }
  if (ready.stock_deficits.length) {
    const err = new Error("库存不足，请先由采购负责人确认到货：" + ready.stock_deficits.map(d => `${d.name}缺${d.short}g`).join("；"));
    err.code = "INSUFFICIENT_STOCK";
    err.deficits = ready.stock_deficits;
    throw err;
  }

  /* 逐行扣库存：同食材汇总为一次库存扣减，逐行记录实际消耗克重，保证行级可追溯 */
  const dayLines = fp.lines.filter(l => l.day === dayIndex && l.status !== "dropped");
  const totals = {};
  for (const ln of dayLines) totals[ln.food_id] = round1((totals[ln.food_id] || 0) + ln.grams);
  const ts = nowStamp();
  for (const [foodId, grams] of Object.entries(totals)) {
    hh.consume(state, { food_id: foodId, grams, source: "plan", day_index: dayIndex, member: null });
  }
  for (const ln of dayLines) {
    ln.status = "consumed";
    ln.consumed_grams = ln.grams;
    ln.consumed_ts = ts;
  }
  fp.consumed_days.push(dayIndex);
  fp.consumed_days.sort((a, b) => a - b);
  fp.events.push({ id: state.next_event_id++, ts, kind: "consume_day", by: actorId == null ? null : Number(actorId), day: dayIndex });
  resyncFamilyShopping(state);
  return familyView(state);
}

/* ---------------- 营养目标与追溯 ---------------- */

function memberDayNutrition(state, memberId, dayIndex) {
  const fp = state.family_plan;
  if (!fp) return null;
  const items = fp.lines
    .filter(l => l.member_id === Number(memberId) && l.day === Number(dayIndex) && l.status !== "dropped")
    .map(l => ({ food_id: l.food_id, grams: l.grams }));
  if (!items.length) return null;
  const t = totalOf(items);
  const member = memberById(state, memberId);
  const req = member ? getRequirement(member.profile) : null;
  const cost = items.reduce((s, it) => s + costFor(getFood(it.food_id), it.grams), 0);
  return { totals: t, cost: round1(cost), requirement: req };
}

function familyTrace(state, query) {
  query = query || {};
  const fp = state.family_plan;
  if (!fp) throw new Error("尚未生成分餐菜单");
  let lines = [...fp.lines];
  if (query.member_id != null) lines = lines.filter(l => l.member_id === Number(query.member_id));
  if (query.food_id) lines = lines.filter(l => l.food_id === query.food_id || l.substitutions.some(s => s.from === query.food_id || s.to === query.food_id));
  if (query.day != null) lines = lines.filter(l => l.day === Number(query.day));

  const decorated = lines.map(l => lineView(state, l));
  /* 食材维度：聚合计划 / 替换 / 消耗 */
  const byFood = {};
  for (const l of decorated) {
    byFood[l.food_id] = byFood[l.food_id] || { food_id: l.food_id, name: l.name, planned_grams: 0, consumed_grams: 0, lines: 0, substitutions: 0 };
    byFood[l.food_id].planned_grams = round1(byFood[l.food_id].planned_grams + l.planned_grams);
    byFood[l.food_id].consumed_grams = round1(byFood[l.food_id].consumed_grams + (l.consumed_grams || 0));
    byFood[l.food_id].lines += 1;
    byFood[l.food_id].substitutions += l.substitutions.length;
  }
  /* 采购到货追溯（分餐来源） */
  const shopping = state.shopping
    .filter(i => i.source === "family" && (query.food_id == null || i.food_id === query.food_id))
    .map(i => ({
      id: i.id, cycle: i.cycle, food_id: i.food_id, name: getFood(i.food_id).name,
      grams: i.grams, status: i.status, est_cost: i.est_cost,
      arrived_grams: i.arrived_grams, actual_cost: i.actual_cost,
      assignee_name: i.assignee != null ? (memberById(state, i.assignee) || {}).name : null,
      arrived_by_name: i.arrived_by != null ? (memberById(state, i.arrived_by) || {}).name : null,
    }));
  const logs = state.consumption
    .filter(l => l.cycle === fp.cycle && (query.food_id == null || l.food_id === query.food_id))
    .map(l => ({ ...l, day_name: DAY_NAMES[l.day_index] || null }));

  return {
    cycle: fp.cycle,
    current_cycle: state.cycle_no,
    stale: !familyCurrent(state),
    member_ids: fp.member_ids,
    lines: decorated,
    by_food: Object.values(byFood).sort((a, b) => b.planned_grams - a.planned_grams),
    shopping,
    consumption: logs,
    events: [...fp.events].sort((a, b) => a.ts - b.ts || a.id - b.id),
  };
}

/* ---------------- 视图 ---------------- */

function lineView(state, ln) {
  const f = getFood(ln.food_id);
  const m = memberById(state, ln.member_id);
  return {
    ...ln,
    name: f ? f.name : ln.food_id,
    meal_label: MEAL_LABEL[ln.meal] || ln.meal,
    day_name: DAY_NAMES[ln.day],
    member_name: m ? m.name : "（已删除成员）",
    est_cost: round2(costFor(f, ln.grams)),
  };
}

/* 分餐菜单各成员营养目标与每日达成（有效行口径） */
function memberNutritionSummary(state, fp) {
  return fp.member_ids.map(id => {
    const m = memberById(state, id);
    const req = m ? getRequirement(m.profile) : null;
    const days = [];
    for (let d = 0; d < 7; d++) days.push(Object.assign({ day: d }, memberDayNutrition(state, id, d)));
    return { member_id: id, name: m ? m.name : "（已删除成员）", profile_label: req ? req.profile_label : null, requirement: req, days };
  });
}

function familyView(state) {
  const fp = state.family_plan;
  if (!fp) {
    return { exists: false, current: false, consumed_days: [], progress: null, lines: [], days: [], members: [], nutrition: [], deficits: [], est_purchase_cost: 0 };
  }
  const members = fp.member_ids.map(id => {
    const m = memberById(state, id);
    return { member_id: id, name: m ? m.name : "（已删除成员）", role: m ? m.role : null, allergens: m ? m.allergens : [], exclude: m ? m.exclude : [] };
  });

  const lineViews = fp.lines.map(l => lineView(state, l));
  const active = lineViews.filter(l => l.status !== "dropped");
  const counts = { total: active.length, confirmed: 0, substituted: 0, consumed: 0, pending: 0 };
  for (const l of active) {
    if (l.status === "consumed") counts.consumed++;
    else if (l.status === "confirmed") counts.confirmed++;
    else counts.pending++;
    if (l.substitutions.length) counts.substituted++;
  }

  const days = [];
  for (let d = 0; d < 7; d++) {
    const ready = familyCurrent(state) ? familyDayReady(state, d) : null;
    const dayLines = lineViews.filter(l => l.day === d);
    days.push({
      day: d,
      day_name: DAY_NAMES[d],
      consumed: fp.consumed_days.includes(d),
      lines: dayLines.length,
      cost: round1(dayLines.reduce((s, l) => s + l.est_cost, 0)),
      ready: ready ? ready.ready : false,
      members: ready ? ready.members : members.map(x => ({ member_id: x.member_id, name: x.name, confirmed: false })),
      stock_deficits: ready ? ready.stock_deficits : [],
    });
  }

  return {
    exists: true,
    current: familyCurrent(state),
    cycle: fp.cycle,
    created_ts: fp.created_ts,
    consumed_days: [...fp.consumed_days],
    members,
    lines: lineViews,
    member_days: fp.member_days,
    days,
    progress: counts,
    nutrition: memberNutritionSummary(state, fp),
    est_purchase_cost: fp.est_purchase_cost,
    budget: hh.budgetSummary(state),
    deficits: familyCurrent(state) ? familyDeficits(state, fp) : [],
  };
}

/* 注入 household 的库存变化重算钩子：家长报废批次后，分餐采购净需求自动补替换采购 */
hh.setFamilyResyncHook((state) => resyncFamilyShopping(state));

module.exports = {
  buildFamilyPlan, setLineGrams, confirmPortions,
  substituteOptions, substituteLine,
  arriveFamilyItem, consumeFamilyDay, familyDayReady,
  familyView, familyTrace, familyCurrent, familyNeed, familyDeficits, familyStockDeficits,
  plannedWeeklyUsed, memberDayNutrition, resyncFamilyShopping,
};

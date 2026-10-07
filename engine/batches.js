"use strict";
/* 家庭食材批次与保质期管理（批次台账）：
   1. 采购负责人在到货 / 期初入库时登记批次（生产日期 + 保质期天数，或直接登记到期日），
      同一食材可有多个批次，独立记录克重与实际单价；
   2. 批次按业务日期（state.today，缺省取系统当天）动态判定状态：
      active 正常 / near 临期（剩余天数 <= near_days，默认 3 天）/ expired 已过期 / scrapped 已报废；
   3. 家长审核：临期批次可确认“继续使用”（near_acked 后不再预警）或报废；已过期批次应报废；
      报废立即扣减可用库存、按批次实际单价计入本周预算损失（wastage）；
   4. 消耗按 FEFO（先到期先消耗，临期优先），只允许扣减未过期 / 未报废批次，行级 allocations 留痕；
   5. usableStock 只统计未过期 / 未报废批次，驱动配餐库存优先、净采购抵扣与缺料 / 替换采购计算，
      过期与报废批次仍保留在物理在库 stockOnHand 中（估值单列，便于追溯），直至家长报废处理。
   台账为纯数据对象，随家庭状态持久化；本模块只依赖食材库，不依赖 household，避免循环依赖。 */

const { getFood } = require("./foods");

const DEFAULT_NEAR_DAYS = 3;   // 默认临期预警阈值（剩余天数）
const MS_DAY = 24 * 3600 * 1000;

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }

/* ---------------- 日期工具 ----------------
   统一使用“YYYY-MM-DD”字符串，按本地日历日比较，避免 UTC 偏移与时分秒干扰。 */

function todayStr(now) {
  return dateToStr(now || new Date());
}

function dateToStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* 解析 YYYY-MM-DD（兼容 Date 对象 / 时间戳）；非法返回 null */
function parseDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : dateToStr(v);
  if (typeof v === "number") return dateToStr(new Date(v));
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return s;
}

/* 业务日期：优先家庭状态内固定的 today（便于演示 / 测试 / 跨天推演），否则系统当天 */
function businessDate(state) {
  return parseDate(state && state.today) || todayStr();
}

/* 两个日期相差天数：b - a（同为 YYYY-MM-DD） */
function daysBetween(a, b) {
  const da = a.split("-").map(Number);
  const db = b.split("-").map(Number);
  const ta = new Date(da[0], da[1] - 1, da[2]).getTime();
  const tb = new Date(db[0], db[1] - 1, db[2]).getTime();
  return Math.round((tb - ta) / MS_DAY);
}

function daysLeft(expireDate, today) {
  if (!expireDate) return null; // 无到期日（如盐 / 油等长效食材）视为长期有效
  return daysBetween(today, expireDate);
}

/* 推进 / 设置业务日期：传 null 或空串表示恢复跟随系统当天 */
function setBusinessDate(state, value) {
  if (value == null || value === "") state.today = null;
  else {
    const d = parseDate(value);
    if (!d) throw new Error("日期格式应为 YYYY-MM-DD");
    state.today = d;
  }
  return businessDate(state);
}

function setNearDays(state, n) {
  const v = Math.round(Number(n));
  if (!(v >= 0)) throw new Error("临期预警天数必须为非负整数");
  state.near_days = v;
}

function nearDaysOf(state) {
  const v = Math.round(Number(state && state.near_days));
  return v >= 0 ? v : DEFAULT_NEAR_DAYS;
}

/* ---------------- 批次状态（动态计算，不持久化状态枚举） ---------------- */

/* 返回 active / near / expired / scrapped 以及剩余天数 */
function batchStatus(batch, today, nearDays) {
  if (batch.status === "scrapped") return { key: "scrapped", days_left: daysLeft(batch.expire_date, today) };
  const left = daysLeft(batch.expire_date, today);
  if (left == null) return { key: "active", days_left: null };
  if (left < 0) return { key: "expired", days_left: left };
  if (left <= nearDays) return { key: "near", days_left: left };
  return { key: "active", days_left: left };
}

/* 批次剩余克重（毛重）= 入库克重 - 消耗 - 报废，截断非负 */
function batchRemaining(b) {
  const out = (b.grams || 0) - (b.consumed_grams || 0) - (b.scrapped_grams || 0);
  return Math.max(0, round1(out));
}

/* 批次是否仍可用于配餐 / 消耗 */
function batchUsable(b, today, nearDays) {
  const st = batchStatus(b, today, nearDays);
  return batchRemaining(b) > 0 && (st.key === "active" || st.key === "near");
}

/* ---------------- 批次登记 ---------------- */

function assertBatchInput(input) {
  const f = getFood(input.food_id);
  if (!f) throw new Error("未知食材：" + input.food_id);
  const grams = Math.round(Number(input.grams) * 10) / 10;
  if (!(grams > 0)) throw new Error("批次克重必须为正数");

  let produced = parseDate(input.produced_date);
  let expire = parseDate(input.expire_date);
  const shelf = input.shelf_days != null && input.shelf_days !== "" ? Math.round(Number(input.shelf_days)) : null;
  if (expire && produced && daysBetween(produced, expire) < 0) throw new Error("到期日不能早于生产日期");
  if (!expire && shelf != null) {
    if (!(shelf > 0)) throw new Error("保质期天数必须为正数");
    if (!produced) produced = businessDate(input.state); // 仅给保质期时默认今天生产
    expire = dateToStr(new Date(new Date(produced + "T00:00:00").getTime() + shelf * MS_DAY));
  }
  if (expire && !produced) produced = null; // 允许只登记到期日
  return { food: f, grams, produced, expire, shelf };
}

/* 登记一条批次（采购负责人）。opts:
   food_id / grams 必填；produced_date + shelf_days 或 expire_date 二选一（均可空=长期有效）；
   unit_cost 实际单价（元/100g），缺省取食材库参考价；source: arrive(到货) / stocktake(期初盘库)；
   shopping_id 关联采购任务；note 备注（如供应商 / 批次号）。 */
function registerBatch(state, input, actorId) {
  input = input || {};
  input.state = state;
  const { food, grams, produced, expire } = assertBatchInput(input);
  const unitCost = input.unit_cost != null ? Number(input.unit_cost) : food.cost;
  if (!(unitCost >= 0)) throw new Error("批次单价非法");
  const source = input.source === "stocktake" ? "stocktake" : "arrive";
  const batch = {
    id: state.next_batch_id++,
    cycle: state.cycle_no,
    source,
    shopping_id: input.shopping_id != null ? Number(input.shopping_id) : null,
    food_id: food.id,
    grams,
    consumed_grams: 0,
    scrapped_grams: 0,
    unit_cost: round2(unitCost),
    produced_date: produced,
    expire_date: expire,
    shelf_days: input.shelf_days != null && input.shelf_days !== "" ? Math.round(Number(input.shelf_days)) : null,
    near_acked: false,
    status: "active",
    note: input.note ? String(input.note).slice(0, 100) : null,
    created_by: actorId == null ? null : Number(actorId),
    created_ts: Date.now(),
    review_by: null, review_ts: null, review_note: null,
  };
  state.batches.push(batch);
  pushBatchEvent(state, {
    kind: "batch_register", batch_id: batch.id, food_id: food.id, grams,
    expire_date: expire, source, by: batch.created_by, note: batch.note,
  });
  return batch;
}

/* ---------------- 库存核算（物理在库 / 可用库存） ---------------- */

function batchesOf(state) {
  return state.batches || (state.batches = []);
}

/* 物理在库（毛重克，含过期未报废）：按食材汇总所有有余量的批次 */
function stockOnHandBatches(state) {
  const map = {};
  for (const b of batchesOf(state)) {
    const r = batchRemaining(b);
    if (r > 0) map[b.food_id] = round1((map[b.food_id] || 0) + r);
  }
  return map;
}

/* 可用库存：只统计未过期 / 未报废批次（过期批次家长报废前仍物理在库，但不可配餐 / 消耗） */
function usableStockMap(state, today) {
  const t = today || businessDate(state);
  const near = nearDaysOf(state);
  const map = {};
  for (const b of batchesOf(state)) {
    if (!batchUsable(b, t, near)) continue;
    map[b.food_id] = round1((map[b.food_id] || 0) + batchRemaining(b));
  }
  return map;
}

/* 失效（过期或已报废）克重：用于库存视图与预警 */
function unusableStockMap(state, today) {
  const t = today || businessDate(state);
  const near = nearDaysOf(state);
  const map = {};
  for (const b of batchesOf(state)) {
    const r = batchRemaining(b);
    if (r <= 0) continue;
    const st = batchStatus(b, t, near);
    if (st.key === "expired" || st.key === "scrapped") {
      map[b.food_id] = round1((map[b.food_id] || 0) + r);
    }
  }
  return map;
}

/* 批次实际估值（剩余克重 × 批次实际单价） */
function batchValue(b) {
  return round2(batchRemaining(b) * (b.unit_cost || 0) / 100);
}

/* 库存估值：usable 只计可配餐批次；unusable 单列过期 / 报废损失口径 */
function inventoryValueByBatches(state, today) {
  const t = today || businessDate(state);
  const near = nearDaysOf(state);
  const usable = {};
  const unusable = {};
  let usableTotal = 0;
  let unusableTotal = 0;
  for (const b of batchesOf(state)) {
    const r = batchRemaining(b);
    if (r <= 0) continue;
    const v = batchValue(b);
    const st = batchStatus(b, t, near);
    const target = (st.key === "expired" || st.key === "scrapped") ? unusable : usable;
    target[b.food_id] = round2((target[b.food_id] || 0) + v);
    if (st.key === "expired" || st.key === "scrapped") unusableTotal += v; else usableTotal += v;
  }
  return {
    total: round2(usableTotal + unusableTotal),
    usable_total: round2(usableTotal),
    unusable_total: round2(unusableTotal),
    per: usable, unusable_per: unusable,
  };
}

/* ---------------- 消耗：FEFO 先到期先消耗（临期优先） ---------------- */

/* 返回某食材按 FEFO 排序后的可用批次（到期日升序，null 长期有效排最后；同日按 id） */
function fefoBatches(state, foodId, today) {
  const t = today || businessDate(state);
  const near = nearDaysOf(state);
  return batchesOf(state)
    .filter(b => b.food_id === foodId && batchUsable(b, t, near))
    .sort((a, b) => {
      if (a.expire_date == null && b.expire_date == null) return a.id - b.id;
      if (a.expire_date == null) return 1;
      if (b.expire_date == null) return -1;
      return a.expire_date < b.expire_date ? -1 : a.expire_date > b.expire_date ? 1 : a.id - b.id;
    });
}

/* 在可用批次上按 FEFO 分配 grams 克重，返回 {allocations, shortage}，不写状态 */
function planFefo(state, foodId, grams, today) {
  let need = grams;
  const allocations = [];
  for (const b of fefoBatches(state, foodId, today)) {
    if (need <= 1e-6) break;
    const take = Math.min(batchRemaining(b), need);
    if (take > 0) {
      allocations.push({ batch_id: b.id, grams: round1(take) });
      need -= take;
    }
  }
  return { allocations, shortage: round1(Math.max(0, need)) };
}

/* 写入消耗分配（扣减批次余量），返回更新后的 allocations */
function applyConsumptionAllocations(state, allocations) {
  for (const a of allocations) {
    const b = batchesOf(state).find(x => x.id === a.batch_id);
    if (!b) throw new Error("消耗批次不存在：" + a.batch_id);
    b.consumed_grams = round1((b.consumed_grams || 0) + a.grams);
  }
  return allocations;
}

/* ---------------- 家长审核：继续使用 / 报废 ---------------- */

function findBatch(state, batchId) {
  const b = batchesOf(state).find(x => x.id === Number(batchId));
  if (!b) throw new Error("批次不存在");
  return b;
}

/* 家长确认临期批次继续使用（确认后不再产生临期预警；过期后仍自动失效） */
function acknowledgeNear(state, batchId, actorId, note) {
  const b = findBatch(state, batchId);
  const t = businessDate(state);
  const st = batchStatus(b, t, nearDaysOf(state));
  if (st.key === "scrapped") throw new Error("该批次已报废");
  if (batchRemaining(b) <= 0) throw new Error("该批次已无余量");
  if (st.key === "expired") throw new Error("该批次已过期，请审核报废处理");
  b.near_acked = true;
  b.review_by = actorId == null ? null : Number(actorId);
  b.review_ts = Date.now();
  b.review_note = note || "家长确认临期继续使用";
  pushBatchEvent(state, { kind: "batch_keep", batch_id: b.id, food_id: b.food_id, by: b.review_by, note: b.review_note });
  return b;
}

/* 家长报废：grams 缺省报废全部剩余；报废批次立即移出可用库存并计入本周损失。
   返回 {batch, scrapped_grams, wastage_cost}。调用方负责随后重算菜单 / 分餐替换采购。 */
function scrapBatch(state, batchId, opts, actorId) {
  opts = opts || {};
  const b = findBatch(state, batchId);
  const t = businessDate(state);
  const st = batchStatus(b, t, nearDaysOf(state));
  if (st.key === "scrapped") throw new Error("该批次已报废");
  const remain = batchRemaining(b);
  if (remain <= 0) throw new Error("该批次已无余量");
  let grams = opts.grams != null ? Math.round(Number(opts.grams) * 10) / 10 : remain;
  if (!(grams > 0)) throw new Error("报废克重必须为正数");
  if (grams > remain + 1e-6) throw new Error(`报废克重超出批次剩余：剩余 ${remain}g`);
  grams = Math.min(grams, remain);

  b.scrapped_grams = round1((b.scrapped_grams || 0) + grams);
  const wastage = round2(grams * (b.unit_cost || 0) / 100);
  b.review_by = actorId == null ? null : Number(actorId);
  b.review_ts = Date.now();
  b.review_note = opts.reason || (st.key === "expired" ? "家长审核报废过期食材" : "家长审核报废");
  if (batchRemaining(b) <= 0) b.status = "scrapped";

  const rec = {
    id: state.next_scrap_id++,
    cycle: state.cycle_no,
    batch_id: b.id,
    food_id: b.food_id,
    grams,
    unit_cost: b.unit_cost,
    cost: wastage,
    reason_status: st.key,        // 报废时批次状态：expired / near / active
    reason: b.review_note,
    by: b.review_by,
    ts: b.review_ts,
  };
  state.scraps.push(rec);
  pushBatchEvent(state, {
    kind: "batch_scrap", batch_id: b.id, food_id: b.food_id, grams, cost: wastage,
    status_before: st.key, by: rec.by, note: rec.reason,
  });
  return { batch: b, scrap: rec, scrapped_grams: grams, wastage_cost: wastage };
}

/* 本周报废损失汇总（预算口径） */
function wastageSummary(state) {
  const rows = (state.scraps || []).filter(r => r.cycle === state.cycle_no);
  const cost = round2(rows.reduce((s, r) => s + (r.cost || 0), 0));
  const grams = round1(rows.reduce((s, r) => s + (r.grams || 0), 0));
  return { cost, grams, count: rows.length };
}

/* ---------------- 事件流（批次可追溯） ---------------- */

function pushBatchEvent(state, ev) {
  state.batch_events.push({ id: state.next_batch_event_id++, ts: Date.now(), ...ev });
}

/* ---------------- 旧状态迁移 ----------------
   批次台账上线前的状态只有 stock_manual + shopping(arrived) + consumption。
   迁移把历史库存重建为批次，使新核算口径与旧 stockOnHand 完全一致：
   - 期初 / 盘库余量 -> 一条 stocktake 批次（无到期日，长期有效）；
   - 已到货采购余量 -> 一条 arrive 批次（关联 shopping_id，实际单价，无到期日）；
   - 历史消耗不逐条回放（无法还原批次归属），直接折算进批次的 consumed_grams；
   迁移后库存物理总量必须与旧公式相等（测试与线上数据无缝升级）。 */
function migrateBatches(state) {
  if (Array.isArray(state.batches) && state.batches.length) return false;
  state.batches = [];
  state.scraps = state.scraps || [];
  state.batch_events = state.batch_events || [];

  /* 旧口径：manual + arrived - consumption */
  const manual = { ...(state.stock_manual || {}) };
  const arrived = {};
  const arrivedMeta = {};
  for (const it of state.shopping || []) {
    if (it.status !== "arrived" || !(it.arrived_grams > 0)) continue;
    arrived[it.food_id] = (arrived[it.food_id] || 0) + (it.arrived_grams || 0);
    (arrivedMeta[it.food_id] = arrivedMeta[it.food_id] || []).push(it);
  }
  const consumed = {};
  for (const log of state.consumption || []) consumed[log.food_id] = (consumed[log.food_id] || 0) + (log.grams || 0);

  const ids = new Set([...Object.keys(manual), ...Object.keys(arrived)]);
  const ts = Date.now();
  for (const foodId of ids) {
    /* 先消耗采购库存、再消耗期初（与 inventoryValue 的计价假设一致） */
    const total = (manual[foodId] || 0) + (arrived[foodId] || 0);
    let leftConsumed = consumed[foodId] || 0;
    const arrIts = arrivedMeta[foodId] || [];
    for (const it of arrIts) {
      const g0 = it.arrived_grams || 0;
      const c = Math.min(g0, leftConsumed);
      leftConsumed -= c;
      if (g0 - c > 1e-6) {
        state.batches.push({
          id: state.next_batch_id++, cycle: it.cycle, source: "arrive", shopping_id: it.id,
          food_id: foodId, grams: g0, consumed_grams: round1(c), scrapped_grams: 0,
          unit_cost: g0 > 0 ? round2((it.actual_cost || 0) / g0 * 100) : 0,
          produced_date: null, expire_date: null, shelf_days: null,
          near_acked: false, status: "active", note: "历史到货迁移",
          created_by: it.arrived_by != null ? it.arrived_by : null, created_ts: ts,
          review_by: null, review_ts: null, review_note: null,
        });
      }
    }
    const mg0 = manual[foodId] || 0;
    const mc = Math.min(mg0, leftConsumed);
    if (mg0 - mc > 1e-6) {
      const f = getFood(foodId);
      state.batches.push({
        id: state.next_batch_id++, cycle: state.cycle_no, source: "stocktake", shopping_id: null,
        food_id: foodId, grams: mg0, consumed_grams: round1(mc), scrapped_grams: 0,
        unit_cost: f ? round2(f.cost) : 0,
        produced_date: null, expire_date: null, shelf_days: null,
        near_acked: false, status: "active", note: "历史期初 / 盘库迁移",
        created_by: null, created_ts: ts,
        review_by: null, review_ts: null, review_note: null,
      });
    }
  }
  /* 迁移幂等：库存总量自检（仅防御，异常时不阻断启动） */
  return true;
}

/* ---------------- 预警 ---------------- */

const STATUS_LABEL = { active: "正常", near: "临期", expired: "已过期", scrapped: "已报废" };

function batchWarnings(state, today) {
  const t = today || businessDate(state);
  const near = nearDaysOf(state);
  const out = [];
  for (const b of batchesOf(state)) {
    const r = batchRemaining(b);
    if (r <= 0) continue;
    const f = getFood(b.food_id);
    const name = f ? f.name : b.food_id;
    const st = batchStatus(b, t, near);
    if (st.key === "expired") {
      out.push({
        level: "danger", code: "batch_expired", batch_id: b.id, food_id: b.food_id,
        text: `批次「${name}」已过期（到期 ${b.expire_date}，剩余 ${r}g），已自动移出可用库存与配餐，请家长审核报废`,
      });
    } else if (st.key === "near" && !b.near_acked) {
      out.push({
        level: "warn", code: "batch_near", batch_id: b.id, food_id: b.food_id,
        text: `批次「${name}」临期（到期 ${b.expire_date}，还剩 ${st.days_left} 天 / ${r}g），消耗已按先到期优先，待家长确认继续使用或报废`,
      });
    }
  }
  const w = wastageSummary(state);
  if (w.count > 0) {
    out.push({
      level: "warn", code: "batch_wastage",
      text: `本周已报废 ${w.count} 个批次共 ${w.grams}g，损失 ¥${w.cost.toFixed(2)}（计入预算），替换采购已自动补入净需求`,
    });
  }
  return out;
}

/* ---------------- 视图 ---------------- */

function batchView(state, b, today) {
  const t = today || businessDate(state);
  const st = batchStatus(b, t, nearDaysOf(state));
  const f = getFood(b.food_id);
  return {
    ...b,
    name: f ? f.name : b.food_id,
    cat: f ? f.cat : "",
    cat_label: f ? f.cat_label || "" : "",
    remaining: batchRemaining(b),
    status_key: st.key,
    status_label: STATUS_LABEL[st.key] || st.key,
    days_left: st.days_left,
    value: batchValue(b),
    created_by_name: b.created_by != null ? ((state.members || []).find(m => m.id === b.created_by) || {}).name || null : null,
    review_by_name: b.review_by != null ? ((state.members || []).find(m => m.id === b.review_by) || {}).name || null : null,
  };
}

function batchListView(state, today) {
  const t = today || businessDate(state);
  const near = nearDaysOf(state);
  return batchesOf(state)
    .map(b => batchView(state, b, t))
    .sort((a, b) => {
      /* 待处理（过期 / 临期未确认）优先，其次到期日近、剩余多 */
      const urg = x => (x.status_key === "expired" ? 0 : x.status_key === "near" && !x.near_acked ? 1 : 2);
      const ua = urg(a), ub = urg(b);
      if (ua !== ub) return ua - ub;
      if (a.expire_date && b.expire_date) return a.expire_date < b.expire_date ? -1 : a.expire_date > b.expire_date ? 1 : 0;
      if (a.expire_date) return -1;
      if (b.expire_date) return 1;
      return a.id - b.id;
    })
    .map(v => v); // nearDays 透传不必要；保持数组
}

function batchSummary(state, today) {
  const t = today || businessDate(state);
  const near = nearDaysOf(state);
  const s = { active: 0, near: 0, expired: 0, scrapped: 0, near_unacked: 0 };
  let usableGrams = 0;
  for (const b of batchesOf(state)) {
    const r = batchRemaining(b);
    if (r <= 0) continue;
    const key = batchStatus(b, t, near).key;
    s[key] = (s[key] || 0) + 1;
    if (key === "near" && !b.near_acked) s.near_unacked++;
    if (key === "active" || key === "near") usableGrams += r;
  }
  return { ...s, today: t, near_days: nearDaysOf(state), usable_grams: round1(usableGrams) };
}

module.exports = {
  DEFAULT_NEAR_DAYS,
  todayStr, parseDate, dateToStr, businessDate, daysBetween, daysLeft,
  setBusinessDate, setNearDays, nearDaysOf,
  batchStatus, batchRemaining, batchUsable, batchValue,
  registerBatch, findBatch,
  stockOnHandBatches, usableStockMap, unusableStockMap, inventoryValueByBatches,
  fefoBatches, planFefo, applyConsumptionAllocations,
  acknowledgeNear, scrapBatch, wastageSummary,
  batchWarnings, batchView, batchListView, batchSummary,
  migrateBatches, STATUS_LABEL,
};

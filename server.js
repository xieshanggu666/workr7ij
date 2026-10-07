"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const foodsMod = require("./engine/foods");
const { getRequirement, PROFILE_KEYS, ACTIVITY_KEYS, GOAL_KEYS } = require("./engine/requirements");
const { planDay } = require("./engine/constraints");
const { weekPlan, DAY_NAMES } = require("./engine/menu");
const household = require("./engine/household");
const family = require("./engine/family");

const arg = process.argv.find(a => a.startsWith("--port="));
const PORT = arg ? parseInt(arg.slice(7), 10) : parseInt(process.env.PORT || "8074", 10);
const WEB = path.join(__dirname, "web");

/* ---------- 家庭采购库存状态持久化（单家庭实例，data/ 已在 .gitignore） ---------- */
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "household.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const obj = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const base = household.emptyHousehold();
      const merged = Object.assign(base, obj);
      if (!Number.isInteger(merged.next_member_id)) merged.next_member_id = 1;
      if (!Number.isInteger(merged.next_item_id)) merged.next_item_id = 1;
      if (!Number.isInteger(merged.next_log_id)) merged.next_log_id = 1;
      if (!Number.isInteger(merged.next_line_id)) merged.next_line_id = 1;
      if (!Number.isInteger(merged.next_event_id)) merged.next_event_id = 1;
      /* 旧成员档案补全分餐协作字段 */
      for (const m of merged.members || []) {
        if (!Array.isArray(m.exclude)) m.exclude = [];
        if (!("role" in m)) m.role = null;
      }
      return merged;
    }
  } catch (e) {
    console.error("家庭状态文件损坏，已重置：", e.message);
  }
  return household.emptyHousehold();
}

let state = loadState();
let saveTimer = null;
function saveState() {
  /* 合并高频写入，落盘失败不阻断操作 */
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("家庭状态保存失败：", e.message);
    }
  }, 120);
}

function hh(body) {
  saveState();
  const view = household.householdView(state);
  view.family = family.familyView(state);
  return view;
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => {
      buf += c;
      if (buf.length > 2e6) req.destroy();
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

function sanitizeProfile(profile) {
  const p = profile || {};
  if (!PROFILE_KEYS[p.age_group]) p.age_group = "adult_m";
  if (!ACTIVITY_KEYS[p.activity]) p.activity = "moderate";
  if (!GOAL_KEYS[p.goal]) p.goal = "maintain";
  return p;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/api/system" && req.method === "GET") {
      return json(res, 200, { name: "nutrition-planner", version: 1, title: "家庭营养膳食规划系统" });
    }
    if (p === "/api/meta" && req.method === "GET") {
      return json(res, 200, {
        profiles: PROFILE_KEYS,
        activities: ACTIVITY_KEYS,
        goals: GOAL_KEYS,
        allergens: foodsMod.ALLERGENS,
        categories: foodsMod.CATEGORY_LABEL,
        units: foodsMod.NUTRIENT_UNIT,
        nutrient_labels: foodsMod.NUTRIENT_LABEL,
        nutrient_order: foodsMod.NUTRIENT_ORDER,
        member_roles: household.MEMBER_ROLES,
      });
    }
    if (p === "/api/foods" && req.method === "GET") {
      return json(res, 200, { foods: foodsMod.listFoods() });
    }
    if (p === "/api/plan" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const profile = sanitizeProfile(body.profile);
      const params = {
        profile,
        budget: body.budget,
        allergens: body.allergens || [],
        exclude: body.exclude || [],
        weekly_used: body.weekly_used || {},
      };
      /* 库存联动：在库食材优先、零边际采购成本 */
      if (body.stock && typeof body.stock === "object") params.stock = body.stock;
      const r = planDay(params);
      return json(res, 200, { ...r, requirement: getRequirement(profile), units: foodsMod.NUTRIENT_UNIT });
    }
    if (p === "/api/week" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const profile = sanitizeProfile(body.profile);
      const params = {
        profile,
        budget: body.budget,
        allergens: body.allergens || [],
        exclude: body.exclude || [],
        liver: body.liver,
      };
      if (body.weekly_used && typeof body.weekly_used === "object") params.weekly_used = body.weekly_used;
      if (body.stock && typeof body.stock === "object") params.stock = body.stock;
      const r = weekPlan(params);
      return json(res, 200, {
        ...r,
        day_names: DAY_NAMES,
        requirement: getRequirement(profile),
        units: foodsMod.NUTRIENT_UNIT,
        nutrient_labels: foodsMod.NUTRIENT_LABEL,
        nutrient_order: foodsMod.NUTRIENT_ORDER,
      });
    }

    /* ---------- 家庭采购与库存 ---------- */
    if (p === "/api/household" && req.method === "GET") {
      const view = household.householdView(state);
      view.family = family.familyView(state);
      return json(res, 200, view);
    }
    if (p === "/api/household/budget" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const b = Number(body.weekly_budget);
      if (!(isFinite(b) && b >= 0)) return json(res, 400, { error: "周预算非法" });
      state.weekly_budget = Math.round(b * 100) / 100;
      return json(res, 200, hh());
    }
    if (p === "/api/household/members" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.addMember(state, body);
      return json(res, 200, hh());
    }
    let mm;
    if ((mm = p.match(/^\/api\/household\/members\/(\d+)$/)) && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      household.updateMember(state, Number(mm[1]), body);
      return json(res, 200, hh());
    }
    if ((mm = p.match(/^\/api\/household\/members\/(\d+)$/)) && req.method === "DELETE") {
      household.removeMember(state, Number(mm[1]));
      return json(res, 200, hh());
    }
    /* 依据周菜单生成 / 刷新采购清单并联动全家过敏原 */
    if (p === "/api/household/shopping/build" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const profile = sanitizeProfile(body.profile);
      const params = {
        profile,
        budget: body.budget,
        allergens: household.familyAllergens(state.members),
        exclude: body.exclude || [],
      };
      const sync = household.syncInputs(state);
      if (body.use_stock !== false) {
        params.stock = sync.stock;
        params.weekly_used = sync.weekly_used;
      }
      const plan = weekPlan(params);
      household.setWeek(state, params, plan);
      household.buildShoppingList(state, plan);
      return json(res, 200, { ...hh(), generated_week: plan });
    }
    if (p === "/api/household/shopping" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.addManualItem(state, body);
      return json(res, 200, hh());
    }
    if ((mm = p.match(/^\/api\/household\/shopping\/(\d+)\/assign$/)) && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.assignItem(state, Number(mm[1]), body.assignee == null ? null : Number(body.assignee));
      return json(res, 200, hh());
    }
    if ((mm = p.match(/^\/api\/household\/shopping\/(\d+)\/arrive$/)) && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.arriveItem(state, Number(mm[1]), body);
      return json(res, 200, hh());
    }
    if ((mm = p.match(/^\/api\/household\/shopping\/(\d+)$/)) && req.method === "DELETE") {
      household.removeItem(state, Number(mm[1]));
      return json(res, 200, hh());
    }
    /* 按配餐确认某天消耗（库存扣减 + 本周限次累计） */
    if ((mm = p.match(/^\/api\/household\/consume\/day\/(\d+)$/)) && req.method === "POST") {
      household.consumeDay(state, Number(mm[1]));
      return json(res, 200, hh());
    }
    if (p === "/api/household/consume" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.consume(state, body);
      return json(res, 200, hh());
    }
    if (p === "/api/household/stock" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.setManualStock(state, body.food_id, body.grams);
      return json(res, 200, hh());
    }
    if (p === "/api/household/cycle" && req.method === "POST") {
      household.startNewCycle(state);
      return json(res, 200, hh());
    }

    /* ---------- 家庭分餐协作 ---------- */
    /* 按成员营养目标生成可追溯分餐菜单，并同步采购净需求 / 预算 / 库存 / 过敏限制 */
    if (p === "/api/family/build" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      family.buildFamilyPlan(state, body);
      return json(res, 200, hh());
    }
    if (p === "/api/family" && req.method === "GET") {
      return json(res, 200, family.familyView(state));
    }
    /* 家长调整某行份量（改后回退待确认） */
    let fm;
    if ((fm = p.match(/^\/api\/family\/lines\/(\d+)\/grams$/)) && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      family.setLineGrams(state, Number(fm[1]), body.grams, body.actor_id, body.note);
      return json(res, 200, hh());
    }
    /* 家长确认份量：scope=all|day|member_day|line */
    if (p === "/api/family/portions/confirm" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      family.confirmPortions(state, body, body.actor_id);
      return json(res, 200, hh());
    }
    /* 成员查询本人分餐行的可替换食材 */
    if ((fm = p.match(/^\/api\/family\/lines\/(\d+)\/substitutes$/)) && req.method === "GET") {
      const q = url.searchParams.get("actor_id");
      return json(res, 200, family.substituteOptions(state, Number(fm[1]), q == null ? null : Number(q)));
    }
    /* 成员确认替换（可指定 target_food_id，默认首选） */
    if ((fm = p.match(/^\/api\/family\/lines\/(\d+)\/substitute$/)) && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      family.substituteLine(state, Number(fm[1]), body, body.actor_id);
      return json(res, 200, hh());
    }
    /* 采购负责人确认分餐采购项到货（实际克重 / 实际单价，入库存并记预算） */
    if ((fm = p.match(/^\/api\/family\/shopping\/(\d+)\/arrive$/)) && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const actorId = body.actor_id;
      delete body.actor_id;
      family.arriveFamilyItem(state, Number(fm[1]), body, actorId);
      return json(res, 200, hh());
    }
    /* 家长按日确认分餐消耗（全员份量确认 + 库存齐备后逐行扣减） */
    if ((fm = p.match(/^\/api\/family\/days\/(\d+)\/consume$/)) && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      family.consumeFamilyDay(state, Number(fm[1]), body.actor_id);
      return json(res, 200, hh());
    }
    /* 追溯：?member_id=&food_id=&day= */
    if (p === "/api/family/trace" && req.method === "GET") {
      const q = {
        member_id: url.searchParams.get("member_id"),
        food_id: url.searchParams.get("food_id"),
        day: url.searchParams.get("day"),
      };
      return json(res, 200, family.familyTrace(state, q));
    }

    let f = p === "/" ? "/index.html" : p;
    const fp = path.normalize(path.join(WEB, f));
    if (!fp.startsWith(WEB)) return json(res, 403, { error: "forbidden" });
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      return fs.createReadStream(fp).pipe(res);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof SyntaxError) return json(res, 400, { error: "请求体不是合法 JSON" });
    return json(res, 400, { error: e.message, code: e.code || null, deficits: e.deficits || null });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`nutrition-planner running at http://127.0.0.1:${PORT}`);
});

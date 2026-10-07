"use strict";
/* 膳食参考摄入量（RNI 近似值）：按年龄性别分层，结合活动水平与目标调整。 */

const BASE = {
  child: {
    kcal: 1700, protein: 45, fiber: 20, calcium: 800, iron: 13, vitA: 600, vitC: 65, vitD: 10,
    sodium_max: 1600, potassium: 2200,
  },
  teen_m: {
    kcal: 2400, protein: 70, fiber: 28, calcium: 1000, iron: 16, vitA: 750, vitC: 100, vitD: 10,
    sodium_max: 2000, potassium: 2500,
  },
  teen_f: {
    kcal: 2100, protein: 62, fiber: 26, calcium: 1000, iron: 18, vitA: 700, vitC: 100, vitD: 10,
    sodium_max: 2000, potassium: 2400,
  },
  adult_m: {
    kcal: 2250, protein: 65, fiber: 25, calcium: 800, iron: 12, vitA: 800, vitC: 100, vitD: 10,
    sodium_max: 2000, potassium: 2000,
  },
  adult_f: {
    kcal: 1800, protein: 55, fiber: 25, calcium: 800, iron: 20, vitA: 700, vitC: 100, vitD: 10,
    sodium_max: 2000, potassium: 2000,
  },
  senior_m: {
    kcal: 2000, protein: 60, fiber: 25, calcium: 800, iron: 12, vitA: 750, vitC: 100, vitD: 15,
    sodium_max: 1600, potassium: 2000,
  },
  senior_f: {
    kcal: 1700, protein: 55, fiber: 25, calcium: 1000, iron: 12, vitA: 700, vitC: 100, vitD: 15,
    sodium_max: 1600, potassium: 2000,
  },
};

const ACTIVITY_FACTOR = { light: 1.0, moderate: 1.15, heavy: 1.3 };
const GOAL_FACTOR = { maintain: { kcal: 1.0, protein: 1.0 }, lose: { kcal: 0.85, protein: 1.25 }, gain: { kcal: 1.12, protein: 1.2 } };

const PROFILE_KEYS = {
  child: "儿童(7-10岁)",
  teen_m: "青少年男(11-17岁)",
  teen_f: "青少年女(11-17岁)",
  adult_m: "成年男性",
  adult_f: "成年女性",
  senior_m: "老年男性(60+)",
  senior_f: "老年女性(60+)",
};

const ACTIVITY_KEYS = { light: "轻体力", moderate: "中体力", heavy: "重体力" };
const GOAL_KEYS = { maintain: "维持体重", lose: "减重", gain: "增肌" };

function getRequirement(profile) {
  const base = BASE[profile.age_group];
  if (!base) throw new Error("未知年龄性别分层");
  const act = ACTIVITY_FACTOR[profile.activity] || 1.0;
  const goal = GOAL_FACTOR[profile.goal] || GOAL_FACTOR.maintain;
  return {
    kcal: Math.round(base.kcal * act * goal.kcal),
    protein: Math.round(base.protein * goal.protein),
    fiber: base.fiber,
    calcium: base.calcium,
    iron: base.iron,
    vitA: base.vitA,
    vitC: base.vitC,
    vitD: base.vitD,
    sodium_max: base.sodium_max,
    potassium: base.potassium,
    profile_label: PROFILE_KEYS[profile.age_group],
  };
}

module.exports = { BASE, ACTIVITY_FACTOR, GOAL_FACTOR, PROFILE_KEYS, ACTIVITY_KEYS, GOAL_KEYS, getRequirement };

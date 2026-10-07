"use strict";
/* 食材营养数据库：每 100g 可食部营养素含量（中国食物成分表近似值）。
   营养素单位约定：kcal / g / mg / μgRAE / μg。edible_ratio 为可食部比例。 */

const FOODS = [
  // ---- 主食 ----
  { id: "rice_long", name: "籼米饭", cat: "staple", per100g: { kcal: 114, protein: 2.5, fat: 0.2, carb: 25.9, fiber: 0.3, sodium: 1.0, potassium: 30, calcium: 5, iron: 0.3, vitA: 0, vitC: 0, vitD: 0 }, cost: 0.35, edible_ratio: 1.0, allergens: [], tags: ["低脂", "低钠"], weekly_limit: null },
  { id: "rice_round", name: "粳米饭", cat: "staple", per100g: { kcal: 116, protein: 2.6, fat: 0.3, carb: 25.6, fiber: 0.2, sodium: 1.2, potassium: 25, calcium: 7, iron: 0.2, vitA: 0, vitC: 0, vitD: 0 }, cost: 0.38, edible_ratio: 1.0, allergens: [], tags: ["低脂"], weekly_limit: null },
  { id: "brown_rice", name: "糙米饭", cat: "staple", per100g: { kcal: 112, protein: 2.7, fat: 0.8, carb: 24.2, fiber: 1.8, sodium: 1.5, potassium: 110, calcium: 7, iron: 0.4, vitA: 0, vitC: 0, vitD: 0 }, cost: 0.55, edible_ratio: 1.0, allergens: [], tags: ["高纤维"], weekly_limit: null },
  { id: "millet", name: "小米粥", cat: "staple", per100g: { kcal: 46, protein: 1.4, fat: 0.3, carb: 8.4, fiber: 0.8, sodium: 3.5, potassium: 55, calcium: 4, iron: 0.4, vitA: 3, vitC: 0, vitD: 0 }, cost: 0.45, edible_ratio: 1.0, allergens: [], tags: ["低热量"], weekly_limit: null },
  { id: "oatmeal", name: "燕麦片(熟)", cat: "staple", per100g: { kcal: 67, protein: 2.4, fat: 1.3, carb: 11.7, fiber: 1.7, sodium: 10, potassium: 65, calcium: 9, iron: 0.5, vitA: 0, vitC: 0, vitD: 0 }, cost: 0.65, edible_ratio: 1.0, allergens: ["麸质"], tags: ["高纤维", "高蛋白"], weekly_limit: null },
  { id: "buckwheat", name: "荞麦面(熟)", cat: "staple", per100g: { kcal: 99, protein: 3.2, fat: 0.4, carb: 20.5, fiber: 1.4, sodium: 120, potassium: 120, calcium: 6, iron: 0.6, vitA: 0, vitC: 0, vitD: 0 }, cost: 0.6, edible_ratio: 1.0, allergens: ["麸质"], tags: ["高蛋白"], weekly_limit: null },
  { id: "whole_wheat_bread", name: "全麦面包", cat: "staple", per100g: { kcal: 246, protein: 10.5, fat: 3.0, carb: 44.6, fiber: 6.0, sodium: 350, potassium: 180, calcium: 45, iron: 2.1, vitA: 0, vitC: 0, vitD: 0 }, cost: 1.2, edible_ratio: 1.0, allergens: ["麸质", "乳"], tags: ["高纤维", "高蛋白"], weekly_limit: null },
  { id: "sweet_potato", name: "红薯(蒸)", cat: "staple", per100g: { kcal: 90, protein: 1.1, fat: 0.2, carb: 20.9, fiber: 1.8, sodium: 3.0, potassium: 190, calcium: 15, iron: 0.4, vitA: 360, vitC: 16, vitD: 0 }, cost: 0.5, edible_ratio: 0.85, allergens: [], tags: ["高纤维", "低钠"], weekly_limit: null },
  { id: "corn", name: "玉米(鲜)", cat: "staple", per100g: { kcal: 106, protein: 3.5, fat: 1.2, carb: 20.8, fiber: 2.9, sodium: 1.0, potassium: 300, calcium: 4, iron: 0.6, vitA: 3, vitC: 14, vitD: 0 }, cost: 0.6, edible_ratio: 0.6, allergens: [], tags: ["高纤维"], weekly_limit: null },
  { id: "potato", name: "土豆(蒸)", cat: "staple", per100g: { kcal: 77, protein: 2.0, fat: 0.1, carb: 17.2, fiber: 1.1, sodium: 2.0, potassium: 320, calcium: 6, iron: 0.5, vitA: 0, vitC: 12, vitD: 0 }, cost: 0.4, edible_ratio: 0.9, allergens: [], tags: ["低脂", "低钠"], weekly_limit: null },
  { id: "steamed_bun", name: "馒头", cat: "staple", per100g: { kcal: 223, protein: 7.0, fat: 1.1, carb: 46.0, fiber: 1.2, sodium: 180, potassium: 60, calcium: 15, iron: 1.2, vitA: 0, vitC: 0, vitD: 0 }, cost: 0.5, edible_ratio: 1.0, allergens: ["麸质"], tags: [], weekly_limit: null },
  { id: "spaghetti", name: "意大利面(熟)", cat: "staple", per100g: { kcal: 131, protein: 5.0, fat: 0.6, carb: 25.5, fiber: 1.8, sodium: 130, potassium: 70, calcium: 8, iron: 0.7, vitA: 0, vitC: 0, vitD: 0 }, cost: 0.7, edible_ratio: 1.0, allergens: ["麸质"], tags: ["高蛋白"], weekly_limit: null },

  // ---- 肉蛋 ----
  { id: "chicken_breast", name: "鸡胸肉", cat: "meat", per100g: { kcal: 118, protein: 24.0, fat: 1.9, carb: 0.4, fiber: 0, sodium: 65, potassium: 340, calcium: 6, iron: 0.7, vitA: 4, vitC: 0, vitD: 0.1 }, cost: 2.4, edible_ratio: 1.0, allergens: [], tags: ["高蛋白", "低脂"], weekly_limit: null },
  { id: "chicken_thigh", name: "鸡腿肉", cat: "meat", per100g: { kcal: 180, protein: 18.0, fat: 11.6, carb: 0.2, fiber: 0, sodium: 75, potassium: 250, calcium: 10, iron: 1.0, vitA: 20, vitC: 0, vitD: 0.1 }, cost: 2.0, edible_ratio: 0.85, allergens: [], tags: ["高蛋白"], weekly_limit: null },
  { id: "pork_lean", name: "猪里脊", cat: "meat", per100g: { kcal: 143, protein: 20.2, fat: 6.2, carb: 0.7, fiber: 0, sodium: 60, potassium: 360, calcium: 6, iron: 1.5, vitA: 4, vitC: 0, vitD: 0.4 }, cost: 3.0, edible_ratio: 1.0, allergens: [], tags: ["高蛋白"], weekly_limit: null },
  { id: "beef_tenderloin", name: "牛里脊", cat: "meat", per100g: { kcal: 125, protein: 21.8, fat: 3.8, carb: 0.9, fiber: 0, sodium: 50, potassium: 300, calcium: 5, iron: 2.8, vitA: 3, vitC: 0, vitD: 0.1 }, cost: 4.5, edible_ratio: 1.0, allergens: [], tags: ["高蛋白", "高铁"], weekly_limit: null },
  { id: "beef_brisket", name: "牛腩", cat: "meat", per100g: { kcal: 225, protein: 16.5, fat: 17.0, carb: 0.8, fiber: 0, sodium: 60, potassium: 260, calcium: 6, iron: 2.6, vitA: 3, vitC: 0, vitD: 0.1 }, cost: 3.6, edible_ratio: 1.0, allergens: [], tags: ["高铁"], weekly_limit: null },
  { id: "lamb_lean", name: "瘦羊肉", cat: "meat", per100g: { kcal: 147, protein: 20.2, fat: 6.8, carb: 0.5, fiber: 0, sodium: 80, potassium: 380, calcium: 8, iron: 2.4, vitA: 8, vitC: 0, vitD: 0.2 }, cost: 4.2, edible_ratio: 1.0, allergens: [], tags: ["高蛋白", "高铁"], weekly_limit: null },
  { id: "egg", name: "鸡蛋", cat: "meat", per100g: { kcal: 144, protein: 13.3, fat: 8.8, carb: 2.8, fiber: 0, sodium: 130, potassium: 130, calcium: 56, iron: 2.0, vitA: 234, vitC: 0, vitD: 1.6 }, cost: 1.5, edible_ratio: 0.88, allergens: ["蛋"], tags: ["高蛋白", "高维A"], weekly_limit: null },
  { id: "pork_liver", name: "猪肝", cat: "meat", per100g: { kcal: 129, protein: 19.3, fat: 3.5, carb: 5.0, fiber: 0, sodium: 70, potassium: 230, calcium: 6, iron: 22.6, vitA: 4972, vitC: 20, vitD: 1.1 }, cost: 2.6, edible_ratio: 1.0, allergens: [], tags: ["高铁", "高维A"], weekly_limit: 1 },
  { id: "salmon", name: "三文鱼", cat: "meat", per100g: { kcal: 139, protein: 17.2, fat: 7.8, carb: 0, fiber: 0, sodium: 63, potassium: 361, calcium: 13, iron: 0.5, vitA: 12, vitC: 0, vitD: 12.0 }, cost: 6.5, edible_ratio: 0.9, allergens: ["鱼"], tags: ["高蛋白", "高维D", "富含Omega3"], weekly_limit: null },
  { id: "cod", name: "鳕鱼", cat: "meat", per100g: { kcal: 88, protein: 16.5, fat: 1.8, carb: 0.4, fiber: 0, sodium: 60, potassium: 310, calcium: 11, iron: 0.4, vitA: 14, vitC: 0, vitD: 1.0 }, cost: 5.2, edible_ratio: 0.8, allergens: ["鱼"], tags: ["高蛋白", "低脂"], weekly_limit: null },
  { id: "bass", name: "鲈鱼", cat: "meat", per100g: { kcal: 105, protein: 18.6, fat: 3.4, carb: 0, fiber: 0, sodium: 55, potassium: 270, calcium: 80, iron: 0.9, vitA: 5, vitC: 0, vitD: 0.5 }, cost: 4.8, edible_ratio: 0.8, allergens: ["鱼"], tags: ["高蛋白", "高钙"], weekly_limit: null },
  { id: "shrimp", name: "虾仁", cat: "meat", per100g: { kcal: 93, protein: 18.6, fat: 0.8, carb: 2.8, fiber: 0, sodium: 160, potassium: 250, calcium: 62, iron: 1.5, vitA: 15, vitC: 0, vitD: 0.2 }, cost: 5.0, edible_ratio: 0.7, allergens: ["虾", "贝类"], tags: ["高蛋白", "低脂"], weekly_limit: null },
  { id: "scallop", name: "扇贝", cat: "meat", per100g: { kcal: 74, protein: 12.7, fat: 0.5, carb: 4.2, fiber: 0, sodium: 220, potassium: 200, calcium: 46, iron: 2.4, vitA: 2, vitC: 0, vitD: 0.1 }, cost: 5.5, edible_ratio: 0.5, allergens: ["贝类"], tags: ["高蛋白", "低脂"], weekly_limit: null },

  // ---- 豆乳 ----
  { id: "tofu_north", name: "北豆腐", cat: "dairy", per100g: { kcal: 116, protein: 12.2, fat: 6.8, carb: 4.6, fiber: 0.5, sodium: 25, potassium: 140, calcium: 138, iron: 2.1, vitA: 0, vitC: 0, vitD: 0 }, cost: 1.0, edible_ratio: 1.0, allergens: ["大豆"], tags: ["高蛋白", "高钙"], weekly_limit: null },
  { id: "tofu_south", name: "南豆腐", cat: "dairy", per100g: { kcal: 87, protein: 7.6, fat: 5.3, carb: 3.8, fiber: 0.3, sodium: 20, potassium: 120, calcium: 90, iron: 1.6, vitA: 0, vitC: 0, vitD: 0 }, cost: 0.9, edible_ratio: 1.0, allergens: ["大豆"], tags: ["高蛋白"], weekly_limit: null },
  { id: "soymilk", name: "豆浆", cat: "dairy", per100g: { kcal: 31, protein: 3.0, fat: 1.6, carb: 1.2, fiber: 0.1, sodium: 3.0, potassium: 100, calcium: 10, iron: 0.5, vitA: 0, vitC: 0, vitD: 0 }, cost: 0.5, edible_ratio: 1.0, allergens: ["大豆"], tags: ["低热量", "低钠"], weekly_limit: null },
  { id: "soybean", name: "黄豆(熟)", cat: "dairy", per100g: { kcal: 191, protein: 17.4, fat: 9.5, carb: 18.4, fiber: 4.6, sodium: 2.0, potassium: 520, calcium: 95, iron: 4.0, vitA: 4, vitC: 0, vitD: 0 }, cost: 0.8, edible_ratio: 1.0, allergens: ["大豆"], tags: ["高蛋白", "高纤维", "高钙"], weekly_limit: null },
  { id: "yuba", name: "腐竹(泡发)", cat: "dairy", per100g: { kcal: 152, protein: 14.9, fat: 8.0, carb: 12.6, fiber: 0.9, sodium: 8.0, potassium: 160, calcium: 40, iron: 2.0, vitA: 0, vitC: 0, vitD: 0 }, cost: 1.4, edible_ratio: 1.0, allergens: ["大豆"], tags: ["高蛋白"], weekly_limit: null },
  { id: "milk_full", name: "全脂牛奶", cat: "dairy", per100g: { kcal: 65, protein: 3.2, fat: 3.6, carb: 4.9, fiber: 0, sodium: 55, potassium: 150, calcium: 107, iron: 0.1, vitA: 26, vitC: 1, vitD: 1.2 }, cost: 1.1, edible_ratio: 1.0, allergens: ["乳"], tags: ["高钙", "高维D"], weekly_limit: null },
  { id: "yogurt", name: "酸奶", cat: "dairy", per100g: { kcal: 72, protein: 2.9, fat: 2.7, carb: 8.7, fiber: 0, sodium: 60, potassium: 150, calcium: 118, iron: 0.1, vitA: 15, vitC: 1, vitD: 0.9 }, cost: 1.5, edible_ratio: 1.0, allergens: ["乳"], tags: ["高钙"], weekly_limit: null },
  { id: "cheese", name: "奶酪", cat: "dairy", per100g: { kcal: 328, protein: 25.7, fat: 23.5, carb: 3.5, fiber: 0, sodium: 520, potassium: 75, calcium: 799, iron: 0.4, vitA: 152, vitC: 0, vitD: 0.9 }, cost: 8.0, edible_ratio: 1.0, allergens: ["乳"], tags: ["高蛋白", "高钙"], weekly_limit: null },
  { id: "chickpea", name: "鹰嘴豆(熟)", cat: "dairy", per100g: { kcal: 164, protein: 8.9, fat: 2.6, carb: 27.4, fiber: 7.6, sodium: 4.0, potassium: 290, calcium: 49, iron: 2.9, vitA: 4, vitC: 2, vitD: 0 }, cost: 1.0, edible_ratio: 1.0, allergens: [], tags: ["高蛋白", "高纤维"], weekly_limit: null },

  // ---- 蔬菜 ----
  { id: "broccoli", name: "西兰花", cat: "veg", per100g: { kcal: 36, protein: 4.1, fat: 0.6, carb: 4.3, fiber: 2.6, sodium: 18, potassium: 290, calcium: 66, iron: 1.0, vitA: 42, vitC: 71, vitD: 0 }, cost: 1.8, edible_ratio: 0.8, allergens: [], tags: ["高纤维", "高维C"], weekly_limit: null },
  { id: "spinach", name: "菠菜", cat: "veg", per100g: { kcal: 28, protein: 2.6, fat: 0.3, carb: 4.5, fiber: 1.7, sodium: 85, potassium: 310, calcium: 66, iron: 2.9, vitA: 487, vitC: 32, vitD: 0 }, cost: 1.4, edible_ratio: 0.75, allergens: [], tags: ["高铁", "高维A"], weekly_limit: null },
  { id: "carrot", name: "胡萝卜", cat: "veg", per100g: { kcal: 39, protein: 1.0, fat: 0.2, carb: 8.8, fiber: 2.0, sodium: 55, potassium: 230, calcium: 24, iron: 0.5, vitA: 688, vitC: 6, vitD: 0 }, cost: 0.9, edible_ratio: 0.95, allergens: [], tags: ["高维A"], weekly_limit: null },
  { id: "tomato", name: "番茄", cat: "veg", per100g: { kcal: 20, protein: 0.9, fat: 0.2, carb: 4.0, fiber: 0.5, sodium: 5.0, potassium: 180, calcium: 10, iron: 0.4, vitA: 42, vitC: 19, vitD: 0 }, cost: 1.2, edible_ratio: 0.95, allergens: [], tags: ["低热量", "低钠"], weekly_limit: null },
  { id: "cucumber", name: "黄瓜", cat: "veg", per100g: { kcal: 16, protein: 0.8, fat: 0.2, carb: 2.9, fiber: 0.5, sodium: 3.0, potassium: 110, calcium: 15, iron: 0.4, vitA: 15, vitC: 9, vitD: 0 }, cost: 0.8, edible_ratio: 0.92, allergens: [], tags: ["低热量", "低钠"], weekly_limit: null },
  { id: "green_pepper", name: "青椒", cat: "veg", per100g: { kcal: 22, protein: 1.0, fat: 0.2, carb: 4.1, fiber: 1.4, sodium: 4.0, potassium: 180, calcium: 14, iron: 0.6, vitA: 57, vitC: 72, vitD: 0 }, cost: 1.3, edible_ratio: 0.9, allergens: [], tags: ["高维C"], weekly_limit: null },
  { id: "lettuce", name: "生菜", cat: "veg", per100g: { kcal: 15, protein: 1.3, fat: 0.3, carb: 2.2, fiber: 1.0, sodium: 32, potassium: 170, calcium: 34, iron: 0.8, vitA: 198, vitC: 13, vitD: 0 }, cost: 1.0, edible_ratio: 0.9, allergens: [], tags: ["低热量"], weekly_limit: null },
  { id: "cabbage", name: "大白菜", cat: "veg", per100g: { kcal: 20, protein: 1.5, fat: 0.2, carb: 3.4, fiber: 1.0, sodium: 40, potassium: 130, calcium: 45, iron: 0.6, vitA: 13, vitC: 24, vitD: 0 }, cost: 0.6, edible_ratio: 0.85, allergens: [], tags: ["低热量", "高维C"], weekly_limit: null },
  { id: "celery", name: "芹菜", cat: "veg", per100g: { kcal: 17, protein: 0.8, fat: 0.2, carb: 3.4, fiber: 1.2, sodium: 85, potassium: 230, calcium: 38, iron: 0.9, vitA: 8, vitC: 6, vitD: 0 }, cost: 0.8, edible_ratio: 0.8, allergens: [], tags: ["低热量", "高纤维"], weekly_limit: null },
  { id: "onion", name: "洋葱", cat: "veg", per100g: { kcal: 40, protein: 1.1, fat: 0.2, carb: 9.0, fiber: 1.4, sodium: 4.0, potassium: 150, calcium: 24, iron: 0.5, vitA: 0, vitC: 7, vitD: 0 }, cost: 0.7, edible_ratio: 0.95, allergens: [], tags: ["低钠"], weekly_limit: null },
  { id: "mushroom", name: "口蘑", cat: "veg", per100g: { kcal: 27, protein: 3.6, fat: 0.3, carb: 2.7, fiber: 1.9, sodium: 10, potassium: 310, calcium: 8, iron: 1.4, vitA: 2, vitC: 3, vitD: 1.2 }, cost: 2.2, edible_ratio: 0.95, allergens: [], tags: ["高钾", "高纤维", "高维D"], weekly_limit: null },
  { id: "red_cabbage", name: "紫甘蓝", cat: "veg", per100g: { kcal: 25, protein: 1.4, fat: 0.2, carb: 5.4, fiber: 1.7, sodium: 25, potassium: 180, calcium: 45, iron: 0.7, vitA: 40, vitC: 40, vitD: 0 }, cost: 1.1, edible_ratio: 0.9, allergens: [], tags: ["高纤维", "高维C"], weekly_limit: null },
  { id: "asparagus", name: "芦笋", cat: "veg", per100g: { kcal: 22, protein: 2.6, fat: 0.1, carb: 2.8, fiber: 1.4, sodium: 6.0, potassium: 200, calcium: 20, iron: 0.9, vitA: 21, vitC: 11, vitD: 0 }, cost: 2.8, edible_ratio: 0.7, allergens: [], tags: ["低热量", "高蛋白"], weekly_limit: null },
  { id: "eggplant", name: "茄子", cat: "veg", per100g: { kcal: 23, protein: 1.1, fat: 0.2, carb: 4.9, fiber: 1.3, sodium: 3.0, potassium: 190, calcium: 15, iron: 0.4, vitA: 3, vitC: 5, vitD: 0 }, cost: 1.0, edible_ratio: 0.9, allergens: [], tags: ["低热量"], weekly_limit: null },
  { id: "white_gourd", name: "冬瓜", cat: "veg", per100g: { kcal: 12, protein: 0.4, fat: 0.1, carb: 2.6, fiber: 0.8, sodium: 2.0, potassium: 90, calcium: 19, iron: 0.2, vitA: 3, vitC: 16, vitD: 0 }, cost: 0.6, edible_ratio: 0.8, allergens: [], tags: ["低热量", "低钠"], weekly_limit: null },
  { id: "pumpkin", name: "南瓜", cat: "veg", per100g: { kcal: 23, protein: 0.7, fat: 0.1, carb: 5.3, fiber: 0.8, sodium: 1.0, potassium: 150, calcium: 16, iron: 0.4, vitA: 148, vitC: 8, vitD: 0 }, cost: 0.7, edible_ratio: 0.82, allergens: [], tags: ["低热量"], weekly_limit: null },

  // ---- 水果 ----
  { id: "apple", name: "苹果", cat: "fruit", per100g: { kcal: 53, protein: 0.4, fat: 0.2, carb: 13.7, fiber: 1.7, sodium: 2.0, potassium: 120, calcium: 4, iron: 0.4, vitA: 6, vitC: 5, vitD: 0 }, cost: 1.2, edible_ratio: 0.84, allergens: [], tags: ["高纤维"], weekly_limit: null },
  { id: "banana", name: "香蕉", cat: "fruit", per100g: { kcal: 93, protein: 1.4, fat: 0.2, carb: 22.0, fiber: 1.2, sodium: 1.0, potassium: 350, calcium: 7, iron: 0.3, vitA: 6, vitC: 9, vitD: 0 }, cost: 1.0, edible_ratio: 0.6, allergens: [], tags: ["高钾"], weekly_limit: null },
  { id: "orange", name: "橙子", cat: "fruit", per100g: { kcal: 48, protein: 0.8, fat: 0.2, carb: 11.1, fiber: 0.6, sodium: 1.0, potassium: 160, calcium: 20, iron: 0.4, vitA: 27, vitC: 33, vitD: 0 }, cost: 1.5, edible_ratio: 0.7, allergens: [], tags: ["高维C"], weekly_limit: null },
  { id: "blueberry", name: "蓝莓", cat: "fruit", per100g: { kcal: 57, protein: 0.7, fat: 0.3, carb: 14.5, fiber: 2.4, sodium: 1.0, potassium: 80, calcium: 6, iron: 0.3, vitA: 4, vitC: 10, vitD: 0 }, cost: 4.0, edible_ratio: 1.0, allergens: [], tags: ["高纤维"], weekly_limit: null },
  { id: "kiwi", name: "猕猴桃", cat: "fruit", per100g: { kcal: 61, protein: 0.8, fat: 0.6, carb: 14.5, fiber: 2.6, sodium: 3.0, potassium: 280, calcium: 27, iron: 1.2, vitA: 22, vitC: 62, vitD: 0 }, cost: 2.5, edible_ratio: 0.85, allergens: [], tags: ["高维C", "高纤维"], weekly_limit: null },
  { id: "strawberry", name: "草莓", cat: "fruit", per100g: { kcal: 32, protein: 1.0, fat: 0.2, carb: 7.1, fiber: 1.1, sodium: 4.0, potassium: 130, calcium: 18, iron: 1.8, vitA: 2, vitC: 47, vitD: 0 }, cost: 3.5, edible_ratio: 0.96, allergens: [], tags: ["高维C"], weekly_limit: null },
  { id: "grape", name: "葡萄", cat: "fruit", per100g: { kcal: 45, protein: 0.4, fat: 0.3, carb: 10.3, fiber: 1.0, sodium: 2.0, potassium: 130, calcium: 5, iron: 0.4, vitA: 2, vitC: 4, vitD: 0 }, cost: 1.8, edible_ratio: 0.8, allergens: [], tags: [], weekly_limit: null },
  { id: "pear", name: "梨", cat: "fruit", per100g: { kcal: 51, protein: 0.4, fat: 0.1, carb: 13.3, fiber: 2.2, sodium: 2.0, potassium: 110, calcium: 6, iron: 0.5, vitA: 2, vitC: 6, vitD: 0 }, cost: 1.0, edible_ratio: 0.82, allergens: [], tags: ["高纤维"], weekly_limit: null },

  // ---- 坚果油脂 ----
  { id: "peanut", name: "花生(熟)", cat: "nut", per100g: { kcal: 589, protein: 21.7, fat: 48.0, carb: 21.7, fiber: 6.0, sodium: 20, potassium: 560, calcium: 47, iron: 1.5, vitA: 3, vitC: 2, vitD: 0 }, cost: 1.6, edible_ratio: 1.0, allergens: ["花生"], tags: ["高蛋白", "高脂肪"], weekly_limit: null },
  { id: "walnut", name: "核桃(熟)", cat: "nut", per100g: { kcal: 646, protein: 14.9, fat: 58.8, carb: 19.1, fiber: 9.5, sodium: 6.0, potassium: 380, calcium: 56, iron: 2.9, vitA: 1, vitC: 1, vitD: 0 }, cost: 4.0, edible_ratio: 0.45, allergens: ["坚果"], tags: ["高脂肪", "高纤维"], weekly_limit: null },
  { id: "almond", name: "杏仁", cat: "nut", per100g: { kcal: 578, protein: 20.0, fat: 50.6, carb: 21.5, fiber: 12.0, sodium: 7.0, potassium: 730, calcium: 248, iron: 3.7, vitA: 2, vitC: 0, vitD: 0 }, cost: 4.5, edible_ratio: 1.0, allergens: ["坚果"], tags: ["高钙", "高纤维", "高脂肪"], weekly_limit: null },
  { id: "olive_oil", name: "橄榄油", cat: "nut", per100g: { kcal: 899, protein: 0, fat: 99.9, carb: 0, fiber: 0, sodium: 0, potassium: 0, calcium: 0, iron: 0.1, vitA: 0, vitC: 0, vitD: 0 }, cost: 3.5, edible_ratio: 1.0, allergens: [], tags: ["富含单不饱和脂肪酸"], weekly_limit: null },
  { id: "linseed_oil", name: "亚麻籽油", cat: "nut", per100g: { kcal: 899, protein: 0, fat: 99.9, carb: 0, fiber: 0, sodium: 0, potassium: 0, calcium: 0, iron: 0.1, vitA: 0, vitC: 0, vitD: 0 }, cost: 3.8, edible_ratio: 1.0, allergens: [], tags: ["富含Omega3"], weekly_limit: null },
  { id: "sesame_oil", name: "芝麻油", cat: "nut", per100g: { kcal: 898, protein: 0, fat: 99.7, carb: 0, fiber: 0, sodium: 0, potassium: 0, calcium: 0, iron: 0.2, vitA: 0, vitC: 0, vitD: 0 }, cost: 3.0, edible_ratio: 1.0, allergens: ["芝麻"], tags: [], weekly_limit: null },
];

const CATEGORY_LABEL = {
  staple: "主食", meat: "肉蛋水产", dairy: "豆乳", veg: "蔬菜", fruit: "水果", nut: "坚果油脂",
};

const ALLERGENS = ["麸质", "蛋", "乳", "大豆", "花生", "坚果", "鱼", "虾", "贝类", "芝麻"];

const NUTRIENT_UNIT = {
  kcal: "kcal", protein: "g", fat: "g", carb: "g", fiber: "g",
  sodium: "mg", potassium: "mg", calcium: "mg", iron: "mg",
  vitA: "μgRAE", vitC: "mg", vitD: "μg",
};

const NUTRIENT_LABEL = {
  kcal: "热量", protein: "蛋白质", fat: "脂肪", carb: "碳水化合物", fiber: "膳食纤维",
  sodium: "钠", potassium: "钾", calcium: "钙", iron: "铁",
  vitA: "维生素A", vitC: "维生素C", vitD: "维生素D",
};

const NUTRIENT_ORDER = ["kcal", "protein", "fat", "carb", "fiber", "sodium", "potassium", "calcium", "iron", "vitA", "vitC", "vitD"];

function getFood(id) {
  return FOODS.find(f => f.id === id) || null;
}

function listFoods() {
  return FOODS.map(f => ({
    id: f.id, name: f.name, cat: f.cat, cat_label: CATEGORY_LABEL[f.cat],
    per100g: { ...f.per100g }, cost: f.cost, edible_ratio: f.edible_ratio,
    allergens: [...f.allergens], tags: [...f.tags], weekly_limit: f.weekly_limit,
  }));
}

/* 按可食部折算：毛重 w 克对应营养素 = per100g * (w * edible_ratio) / 100 */
function nutrientsFor(food, grossWeightGrams) {
  const edible = grossWeightGrams * food.edible_ratio;
  const out = {};
  for (const k of NUTRIENT_ORDER) out[k] = (food.per100g[k] * edible) / 100;
  return out;
}

function costFor(food, grossWeightGrams) {
  return (food.cost * grossWeightGrams) / 100;
}

module.exports = {
  FOODS, CATEGORY_LABEL, ALLERGENS, NUTRIENT_UNIT, NUTRIENT_LABEL, NUTRIENT_ORDER,
  getFood, listFoods, nutrientsFor, costFor,
};

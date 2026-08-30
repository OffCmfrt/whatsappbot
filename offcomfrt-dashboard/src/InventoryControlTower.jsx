import React, { useMemo, useState } from "react";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine, Cell,
} from "recharts";
import {
  AlertTriangle, TrendingUp, TrendingDown, Minus, Search, ChevronDown, ChevronRight,
  Package, Truck, Factory, Warehouse, IndianRupee, ArrowUpRight, ArrowDownRight,
  CircleCheck, CircleAlert, CircleX, Clock, ShieldCheck, Scissors, Boxes, X,
} from "lucide-react";

/* ============================================================================
   OFFCOMFRT — INVENTORY CONTROL TOWER
   Single-file React artifact. All data below is seeded synthetic sample data
   built to be internally consistent (stock, velocity, cover, value all derive
   from the same numbers) so the dashboard behaves like a real one, even
   though nothing here is connected to a live system.
   ========================================================================= */

/* ---------- seeded PRNG so the dataset is stable across re-renders ---------- */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260829);
const ri = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const rf = (min, max) => rand() * (max - min) + min;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const inr = (n) => "\u20B9" + Math.round(n).toLocaleString("en-IN");
const inrCr = (n) => "\u20B9" + (n / 1e7).toFixed(2) + " Cr";
const inrL = (n) => "\u20B9" + (n / 1e5).toFixed(1) + " L";
const fmtInr = (n) => (Math.abs(n) >= 1e7 ? inrCr(n) : Math.abs(n) >= 1e5 ? inrL(n) : inr(n));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const TODAY = new Date("2026-08-29");
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtDate = (d) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/* ---------------------------- catalog constants ---------------------------- */
const SIZES5 = ["S", "M", "L", "XL", "XXL"];
const SIZES_W = ["XS", "S", "M", "L", "XL"];
// real apparel size curves are never flat - middle sizes over-index on demand
const SIZE_DEMAND_WEIGHT = { XS: 0.7, S: 0.85, M: 1.35, L: 1.5, XL: 1.1, XXL: 0.55 };

const MANUFACTURERS = [
  { id: "MFG-01", name: "Sundari Knits, Tiruppur", leadTime: 24, reliability: 0.93 },
  { id: "MFG-02", name: "Vardaan Apparel, Ludhiana", leadTime: 32, reliability: 0.81 },
  { id: "MFG-03", name: "Falcon Garments, Noida", leadTime: 21, reliability: 0.9 },
  { id: "MFG-04", name: "Comfort Fab Exports, Bengaluru", leadTime: 28, reliability: 0.86 },
];

const WAREHOUSES = ["Main FC \u2013 Bhiwandi", "3PL \u2013 Gurugram", "Returns Hub \u2013 Bhiwandi"];

const PRODUCTS = [
  { id: "P01", name: "Ringer Tee 001", dept: "Menswear", cat: "T-Shirts", sub: "Ringer Tee", collection: "Core Basics", sizes: SIZES5, colors: ["Black/White", "Navy/Red", "White/Black"], price: 799, cost: 262, profile: "hero", launch: "2025-02-10" },
  { id: "P02", name: "Raglan Tee 001", dept: "Menswear", cat: "T-Shirts", sub: "Raglan", collection: "Core Basics", sizes: SIZES5, colors: ["Black/Grey", "Navy/White", "Olive/Beige"], price: 849, cost: 278, profile: "core", launch: "2025-01-15" },
  { id: "P03", name: "Polo 001", dept: "Menswear", cat: "Polos", sub: "Pique Polo", collection: "Smart Casual", sizes: SIZES5, colors: ["Navy", "Black", "Olive", "White"], price: 999, cost: 341, profile: "core", launch: "2024-11-01" },
  { id: "P04", name: "Oversized Tee", dept: "Unisex", cat: "T-Shirts", sub: "Oversized", collection: "Street", sizes: SIZES5, colors: ["Black", "White", "Sage Green", "Rust"], price: 899, cost: 291, profile: "hero", launch: "2024-10-05" },
  { id: "P05", name: "Crop Tee", dept: "Womenswear", cat: "T-Shirts", sub: "Crop", collection: "Summer 26", sizes: SIZES_W, colors: ["Black", "Lavender", "Off-White"], price: 749, cost: 241, profile: "new", launch: "2026-08-01" },
  { id: "P06", name: "Hoodie 002", dept: "Unisex", cat: "Hoodies", sub: "Fleece Hoodie", collection: "Winter 25", sizes: SIZES5, colors: ["Charcoal Melange", "Black", "Maroon"], price: 1799, cost: 621, profile: "core", launch: "2025-09-20" },
  { id: "P07", name: "Track Pant 003", dept: "Unisex", cat: "Bottoms", sub: "Track Pant", collection: "Core Basics", sizes: SIZES5, colors: ["Black", "Grey Melange", "Navy"], price: 1299, cost: 432, profile: "slow", launch: "2025-03-12" },
  { id: "P08", name: "Women's Comfort Co-ord", dept: "Womenswear", cat: "Loungewear", sub: "Co-ord Set", collection: "Homebound", sizes: SIZES_W, colors: ["Sage", "Blush", "Charcoal"], price: 1999, cost: 693, profile: "dead", launch: "2025-04-18" },
];

const PROFILE_CFG = {
  hero: { velBase: [4, 9], baseCoverDays: [18, 38], volatility: 0.16, zeroWeekProb: 0, ageing: [5, 35] },
  core: { velBase: [1.5, 4], baseCoverDays: [35, 60], volatility: 0.3, zeroWeekProb: 0.03, ageing: [10, 55] },
  new: { velBase: [1, 5], baseCoverDays: [14, 30], volatility: 0.45, zeroWeekProb: 0.15, ageing: [1, 27] },
  slow: { velBase: [0.3, 1.2], baseCoverDays: [150, 240], volatility: 0.55, zeroWeekProb: 0.25, ageing: [70, 160] },
  dead: { velBase: [0.02, 0.15], baseCoverDays: null, volatility: 0.7, zeroWeekProb: 0.5, ageing: [130, 270] },
};

/* -------------------------------- build SKUs -------------------------------- */
function buildSkus() {
  const skus = [];
  let seq = 1;
  for (const product of PRODUCTS) {
    const cfg = PROFILE_CFG[product.profile];
    const mfg = pick(MANUFACTURERS);
    const colorWeights = product.colors.map(() => rf(0.7, 1.3));
    const flatShare = 1 / product.sizes.length;
    const sizeWeights = product.sizes.map((s) => SIZE_DEMAND_WEIGHT[s] ?? 1);
    const weightSum = sizeWeights.reduce((a, b) => a + b, 0);
    const demandShare = sizeWeights.map((w) => w / weightSum);

    product.colors.forEach((color, cIdx) => {
      const baseCoverDays = product.profile === "dead" ? null : ri(cfg.baseCoverDays[0], cfg.baseCoverDays[1]);

      product.sizes.forEach((size, sIdx) => {
        const sizeW = SIZE_DEMAND_WEIGHT[size] ?? 1;
        const velocity = +(rf(cfg.velBase[0], cfg.velBase[1]) * colorWeights[cIdx] * sizeW * rf(0.85, 1.15)).toFixed(2);

        let currentStock;
        if (product.profile === "dead") {
          currentStock = ri(190, 400);
        } else {
          const sizeCoverDays = baseCoverDays * (flatShare / demandShare[sIdx]);
          currentStock = Math.max(0, Math.round(velocity * sizeCoverDays * rf(0.9, 1.1)));
        }

        const lastSaleDaysAgo = velocity > 1.5 ? ri(0, 2) : velocity > 0.6 ? ri(1, 6) : velocity > 0.15 ? ri(6, 30) : ri(45, 165);

        const weeklyBase = velocity * 7;
        const weeks = Array.from({ length: 12 }, () => {
          if (rand() < cfg.zeroWeekProb) return 0;
          return Math.max(0, Math.round(weeklyBase * (1 + (rand() - 0.5) * 2 * cfg.volatility)));
        });
        const mean = weeks.reduce((a, b) => a + b, 0) / weeks.length || 0.0001;
        const variance = weeks.reduce((a, b) => a + (b - mean) ** 2, 0) / weeks.length;
        const cv = Math.sqrt(variance) / (mean || 1);
        const xyz = cv < 0.5 ? "X" : cv < 1.0 ? "Y" : "Z";

        const leadTime = mfg.leadTime;
        const safetyStock = Math.round(velocity * (xyz === "Z" ? 12 : xyz === "Y" ? 8 : 5));
        const reorderPoint = Math.round(velocity * leadTime + safetyStock);

        const hasIncoming = rand() < (product.profile === "hero" || product.profile === "core" ? 0.45 : product.profile === "new" ? 0.6 : product.profile === "dead" ? 0.08 : 0.12);
        const incomingQty = hasIncoming ? ri(40, 220) : 0;
        const incomingEtaDays = hasIncoming ? ri(4, 40) : null;

        const sales7 = Math.round(velocity * 7 * rf(0.85, 1.15));
        const sales14 = Math.round(velocity * 14 * rf(0.85, 1.15));
        const sales30 = Math.round(velocity * 30 * rf(0.85, 1.15));
        const sales60 = Math.round(velocity * 60 * rf(0.85, 1.15));
        const sales90 = Math.round(velocity * 90 * rf(0.85, 1.15));

        const daysOfCover = velocity > 0.05 ? +(currentStock / velocity).toFixed(1) : 999;
        const receivedUnits = currentStock + sales30;
        const sellThrough30 = receivedUnits > 0 ? +((sales30 / receivedUnits) * 100).toFixed(1) : 0;

        const stockoutEta = velocity > 0.05 ? addDays(TODAY, Math.floor(daysOfCover)) : null;
        const incomingArrivesInTime = incomingQty > 0 && incomingEtaDays <= daysOfCover + 3;
        const isStockoutRisk = velocity > 0.05 && daysOfCover <= leadTime && !incomingArrivesInTime;
        const isOverstock = daysOfCover > 90 && velocity > 0.15;
        const isDead = lastSaleDaysAgo > 45 && currentStock > 0;
        const isSlowMover = !isDead && velocity > 0.05 && velocity < (cfg.velBase[0] + cfg.velBase[1]) / 2 * 0.35 && product.profile !== "dead";

        const ageingDays = ri(cfg.ageing[0], cfg.ageing[1]);
        const ageBucket = ageingDays <= 30 ? "0\u201330" : ageingDays <= 60 ? "31\u201360" : ageingDays <= 90 ? "61\u201390" : ageingDays <= 120 ? "91\u2013120" : ageingDays <= 180 ? "121\u2013180" : "180+";

        const landedCost = Math.round(product.cost * 1.08);
        const inTransit = hasIncoming && incomingEtaDays <= 10 ? incomingQty : 0;
        const inProduction = hasIncoming && incomingEtaDays > 10 ? incomingQty : 0;

        skus.push({
          sku: `OC-${product.id}-${color.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase()}-${size}`,
          seq: seq++,
          productId: product.id,
          product: product.name,
          dept: product.dept,
          category: product.cat,
          subcategory: product.sub,
          collection: product.collection,
          color, size,
          launch: product.launch,
          manufacturer: mfg.name,
          manufacturerId: mfg.id,
          warehouse: WAREHOUSES[0],
          unitCost: product.cost,
          landedCost,
          mrp: product.price,
          price: product.price,
          currentStock,
          reserved: Math.round(currentStock * rf(0, 0.06)),
          damaged: rand() < 0.08 ? ri(1, 6) : 0,
          qcHold: rand() < 0.05 ? ri(2, 10) : 0,
          returned: rand() < 0.12 ? ri(1, 9) : 0,
          inTransit, inProduction,
          incomingQty, incomingEtaDays,
          velocity, sales7, sales14, sales30, sales60, sales90,
          sellThrough30, receivedUnits,
          daysOfCover, weeksOfSupply: +(daysOfCover / 7).toFixed(1),
          leadTime, safetyStock, reorderPoint,
          safetyStockOverride: null,
          xyz, cv: +cv.toFixed(2),
          lastSaleDaysAgo,
          lastSaleDate: fmtDate(addDays(TODAY, -lastSaleDaysAgo)),
          stockoutEta, isStockoutRisk, isOverstock, isDead, isSlowMover,
          ageingDays, ageBucket,
          profile: product.profile,
          weeklySales: weeks,
          storageBin: `${pick(["A", "B", "C"])}-${ri(1, 24)}-${ri(1, 4)}`,
        });
      });
    });
  }
  return skus;
}

/* -------------------------- ABC classification -------------------------- */
function applyAbc(skus) {
  const withRevenue = skus.map((s) => ({ s, revenue30: s.sales30 * s.price }));
  withRevenue.sort((a, b) => b.revenue30 - a.revenue30);
  const totalRevenue = withRevenue.reduce((a, x) => a + x.revenue30, 0) || 1;
  let cum = 0;
  for (const x of withRevenue) {
    cum += x.revenue30;
    const cumPct = cum / totalRevenue;
    x.s.revenue30 = x.revenue30;
    x.s.abc = cumPct <= 0.7 ? "A" : cumPct <= 0.9 ? "B" : "C";
  }
  return skus;
}

/* -------------------------- replenishment logic -------------------------- */
function classifyReplenishment(s) {
  const targetCover = s.profile === "hero" ? 45 : s.profile === "new" ? 35 : 60;
  const pipeline = s.inTransit + s.inProduction;
  const recommendedQty = Math.max(0, Math.round(s.velocity * targetCover + s.safetyStock - s.currentStock - pipeline));
  const purchaseValue = recommendedQty * s.landedCost;

  let bucket, reason, priority;
  if (s.isDead || s.profile === "dead") {
    bucket = "DO NOT BUY"; reason = `No meaningful sale in ${s.lastSaleDaysAgo}d \u2013 capital better spent elsewhere`; priority = "Low";
  } else if (s.isOverstock) {
    bucket = "OVERSTOCK \u2013 DO NOT REPLENISH"; reason = `${s.daysOfCover}d cover already on hand vs ${s.leadTime}d lead time`; priority = "Low";
  } else if (s.isStockoutRisk) {
    bucket = "BUY NOW"; reason = `Stocks out in ${Math.floor(s.daysOfCover)}d, replenishment takes ${s.leadTime}d`; priority = "Critical";
  } else if (s.daysOfCover <= s.leadTime + 14) {
    bucket = "BUY SOON"; reason = `${s.daysOfCover}d cover approaching ${s.leadTime}d lead time`; priority = "High";
  } else if (s.daysOfCover <= 90) {
    bucket = "MONITOR"; reason = `${s.daysOfCover}d cover \u2013 healthy for now`; priority = "Normal";
  } else {
    bucket = "MONITOR"; reason = "Within acceptable range"; priority = "Normal";
  }
  return { bucket, reason, priority, recommendedQty, purchaseValue, targetCover };
}

/* -------------------------- forecast accuracy (WMAPE) -------------------------- */
function weightedMovingForecast(weeks) {
  // forecast week 12 from a recency-weighted average of weeks 7-11 (stockout-adjusted: this is why
  // we forecast off multiple recent weeks rather than a single day, so a bad week doesn't crater the number)
  const recent = weeks.slice(6, 11);
  const weights = [1, 1.2, 1.5, 1.8, 2.2];
  const wsum = weights.reduce((a, b) => a + b, 0);
  const forecast = recent.reduce((a, v, i) => a + v * weights[i], 0) / wsum;
  return forecast;
}

/* -------------------------------- purchase orders -------------------------------- */
function buildPurchaseOrders(skus) {
  const statuses = ["Open", "Partially Received", "Fully Received", "Delayed", "Cancelled"];
  const weights = [0.28, 0.2, 0.28, 0.18, 0.06];
  const pos = [];
  const candidateProducts = [...new Set(skus.map((s) => s.productId))];
  for (let i = 0; i < 16; i++) {
    const productId = pick(candidateProducts);
    const productSkus = skus.filter((s) => s.productId === productId);
    const sample = productSkus[0];
    let r = rand(), acc = 0, status = statuses[0];
    for (let j = 0; j < statuses.length; j++) { acc += weights[j]; if (r <= acc) { status = statuses[j]; break; } }
    const orderQty = ri(150, 900);
    const orderedDaysAgo = ri(5, 60);
    const orderDate = addDays(TODAY, -orderedDaysAgo);
    const expectedDate = addDays(orderDate, sample.leadTime);
    let receivedQty = 0, actualDate = null, daysDelayed = 0;
    if (status === "Fully Received") { receivedQty = orderQty; actualDate = addDays(expectedDate, ri(-3, 2)); daysDelayed = Math.max(0, Math.round((actualDate - expectedDate) / 86400000)); }
    else if (status === "Partially Received") { receivedQty = Math.round(orderQty * rf(0.3, 0.75)); }
    else if (status === "Delayed") { daysDelayed = ri(4, 22); }
    pos.push({
      poId: `PO-${1000 + i}`,
      product: sample.product, productId, manufacturer: sample.manufacturer,
      manufacturerId: sample.manufacturerId, orderQty, receivedQty,
      balance: orderQty - receivedQty, status, orderDate: fmtDate(orderDate),
      expectedDate: fmtDate(expectedDate), actualDate: actualDate ? fmtDate(actualDate) : "\u2013",
      daysDelayed, leadTime: sample.leadTime,
    });
  }
  return pos;
}

/* -------------------------------- production orders -------------------------------- */
function buildProductionOrders(skus) {
  const stages = ["Cutting", "Stitching", "Finishing", "QC", "Packing", "Dispatched"];
  const orders = [];
  const candidateProducts = [...new Set(skus.map((s) => s.productId))];
  for (let i = 0; i < 10; i++) {
    const productId = pick(candidateProducts);
    const sample = skus.find((s) => s.productId === productId);
    const planned = ri(400, 1400);
    const stageIdx = ri(0, stages.length - 1);
    const currentStage = stages[stageIdx];
    const progressPct = clamp((stageIdx + 1) / stages.length + rf(-0.08, 0.08), 0.08, 1);
    const cut = Math.round(planned * clamp(progressPct + 0.15, 0, 1));
    const stitched = Math.round(planned * clamp(progressPct + 0.05, 0, 1));
    const finished = Math.round(planned * clamp(progressPct, 0, 1));
    const qcPassed = Math.round(finished * rf(0.9, 0.98));
    const packed = stageIdx >= 4 ? Math.round(qcPassed * rf(0.85, 1)) : 0;
    const dispatched = stageIdx >= 5 ? packed : 0;
    const deadlineDays = ri(-6, 30);
    const startDaysAgo = ri(10, 45);
    const status = deadlineDays < 0 ? "Delayed" : deadlineDays < 6 ? "At Risk" : "On Track";
    orders.push({
      id: `PRD-${300 + i}`, product: sample.product, productId,
      manufacturer: sample.manufacturer, planned, cut, stitched, finished, qcPassed, packed, dispatched,
      currentStage, status,
      productionStart: fmtDate(addDays(TODAY, -startDaysAgo)),
      deadline: fmtDate(addDays(TODAY, deadlineDays)),
      eta: fmtDate(addDays(TODAY, Math.max(deadlineDays, 2))),
      deadlineDays,
    });
  }
  return orders;
}

/* -------------------------------- raw materials -------------------------------- */
function buildRawMaterials() {
  const items = [
    { name: "Cotton Single Jersey Fabric (Black)", unit: "kg", cost: 385 },
    { name: "Cotton Single Jersey Fabric (White)", unit: "kg", cost: 370 },
    { name: "Rib Fabric \u2013 Collar/Cuff", unit: "kg", cost: 410 },
    { name: "Woven Main Label", unit: "pcs", cost: 3.2 },
    { name: "Care Label", unit: "pcs", cost: 1.1 },
    { name: "Polybag \u2013 Branded", unit: "pcs", cost: 2.4 },
    { name: "Carton \u2013 Export Grade", unit: "pcs", cost: 28 },
    { name: "Sewing Thread \u2013 Cone", unit: "cone", cost: 65 },
  ];
  return items.map((it, i) => {
    const opening = ri(400, 3200);
    const inward = ri(200, 1500);
    const consumption = ri(300, 1600);
    const wastage = Math.round(consumption * rf(0.01, 0.04));
    const closing = Math.max(0, opening + inward - consumption - wastage);
    const minStock = Math.round(consumption * rf(0.6, 1));
    return { id: `RM-${i + 1}`, ...it, opening, inward, consumption, wastage, closing, minStock, supplier: pick(MANUFACTURERS).name, leadTime: ri(7, 21), belowMin: closing < minStock };
  });
}

/* -------------------------------- campaigns -------------------------------- */
function buildCampaigns(skus) {
  const defs = [
    { name: "Diwali Sale \u2013 Site-wide", productId: "P04", upliftPct: 45, startInDays: 12, durationDays: 10 },
    { name: "Meta Prospecting \u2013 Ringer Tee", productId: "P01", upliftPct: 30, startInDays: 5, durationDays: 21 },
    { name: "Influencer Drop \u2013 Crop Tee", productId: "P05", upliftPct: 60, startInDays: 3, durationDays: 14 },
  ];
  return defs.map((c) => {
    const relevant = skus.filter((s) => s.productId === c.productId);
    const stock = relevant.reduce((a, s) => a + s.currentStock, 0);
    const incoming = relevant.reduce((a, s) => a + s.inTransit + s.inProduction, 0);
    const dailyVel = relevant.reduce((a, s) => a + s.velocity, 0);
    const expectedDailyDuringCampaign = dailyVel * (1 + c.upliftPct / 100);
    const forecastUnits = Math.round(expectedDailyDuringCampaign * c.durationDays);
    const available = stock + (c.startInDays < 20 ? incoming : 0);
    const readiness = available >= forecastUnits ? "Ready" : available >= forecastUnits * 0.6 ? "Risk" : "Not Ready";
    return { ...c, product: relevant[0]?.product, stock, incoming, forecastUnits, available, readiness, startDate: fmtDate(addDays(TODAY, c.startInDays)) };
  });
}

/* -------------------------------- suppliers scorecard -------------------------------- */
function buildSupplierScorecard(pos) {
  return MANUFACTURERS.map((m) => {
    const mine = pos.filter((p) => p.manufacturerId === m.id);
    const ordered = mine.reduce((a, p) => a + p.orderQty, 0) || 1;
    const received = mine.reduce((a, p) => a + p.receivedQty, 0);
    const delayed = mine.filter((p) => p.status === "Delayed").length;
    const onTimePct = Math.round(m.reliability * 100);
    const rejectionPct = +(rf(0.5, 5.5)).toFixed(1);
    const shortagePct = +(rf(0, 3.5)).toFixed(1);
    const tone = m.reliability >= 0.9 ? "healthy" : m.reliability >= 0.83 ? "attention" : "critical";
    return {
      id: m.id, name: m.name, orders: mine.length || ri(3, 9), ordered, received,
      onTimePct, delayPct: 100 - onTimePct, rejectionPct, shortagePct,
      avgLeadTime: m.leadTime, leadTimeVariance: ri(2, 8), costVariancePct: +(rf(-4, 7)).toFixed(1),
      tone,
    };
  });
}

/* -------------------------------- top-level aggregation -------------------------------- */
function computeAggregates(skus, pos, prod) {
  const totalUnits = skus.reduce((a, s) => a + s.currentStock, 0);
  const inventoryValue = skus.reduce((a, s) => a + s.currentStock * s.landedCost, 0);
  const reservedUnits = skus.reduce((a, s) => a + s.reserved, 0);
  const damagedUnits = skus.reduce((a, s) => a + s.damaged, 0);
  const qcHoldUnits = skus.reduce((a, s) => a + s.qcHold, 0);
  const returnedUnits = skus.reduce((a, s) => a + s.returned, 0);
  const inTransitUnits = skus.reduce((a, s) => a + s.inTransit, 0);
  const inProductionUnits = skus.reduce((a, s) => a + s.inProduction, 0);
  const sellableValue = skus.reduce((a, s) => a + Math.max(0, s.currentStock - s.reserved - s.damaged - s.qcHold) * s.landedCost, 0);

  const sales30Total = skus.reduce((a, s) => a + s.sales30, 0);
  const sales7Total = skus.reduce((a, s) => a + s.sales7, 0);
  const annualRevenue = skus.reduce((a, s) => a + s.sales30 * 12 * s.price, 0);
  const annualCogs = skus.reduce((a, s) => a + s.sales30 * 12 * s.landedCost, 0);
  const avgDailyUnits = skus.reduce((a, s) => a + s.velocity, 0);

  const daysOfInventory = annualCogs > 0 ? (inventoryValue / annualCogs) * 365 : 0;
  const turnover = daysOfInventory > 0 ? 365 / daysOfInventory : 0;
  const weeksOfSupply = avgDailyUnits > 0 ? totalUnits / avgDailyUnits / 7 : 0;
  const sellThroughAgg = skus.reduce((a, s) => a + s.sales30, 0) / (skus.reduce((a, s) => a + s.receivedUnits, 0) || 1) * 100;

  const stockoutSkuCount = skus.filter((s) => s.currentStock === 0 && s.velocity > 0.05).length;
  const stockoutRate = (stockoutSkuCount / skus.length) * 100;

  const deadStockSkus = skus.filter((s) => s.isDead);
  const deadStockValue = deadStockSkus.reduce((a, s) => a + s.currentStock * s.landedCost, 0);
  const deadStockPct = (deadStockValue / (inventoryValue || 1)) * 100;

  const ageingValue90plus = skus.filter((s) => s.ageingDays > 90).reduce((a, s) => a + s.currentStock * s.landedCost, 0);
  const ageingPct = (ageingValue90plus / (inventoryValue || 1)) * 100;

  const overstockSkus = skus.filter((s) => s.isOverstock);
  const overstockValue = overstockSkus.reduce((a, s) => {
    const targetUnits = s.velocity * 60;
    const excessUnits = Math.max(0, s.currentStock - targetUnits);
    return a + excessUnits * s.landedCost;
  }, 0);

  const stockoutRiskSkus = skus.filter((s) => s.isStockoutRisk);

  // forecast accuracy via WMAPE across all skus with real sales history
  let errSum = 0, actualSum = 0;
  skus.forEach((s) => {
    const actual = s.weeklySales[11];
    const forecast = weightedMovingForecast(s.weeklySales);
    errSum += Math.abs(actual - forecast);
    actualSum += actual;
  });
  const wmape = actualSum > 0 ? (errSum / actualSum) * 100 : 0;
  const forecastAccuracy = clamp(100 - wmape, 0, 100);
  const overForecastBias = skus.filter((s) => weightedMovingForecast(s.weeklySales) > s.weeklySales[11]).length;
  const underForecastBias = skus.length - overForecastBias;

  const grossMarginAnnual = annualRevenue - annualCogs;
  const gmroi = inventoryValue > 0 ? grossMarginAnnual / inventoryValue : 0;
  const invValuePctSales = annualRevenue > 0 ? (inventoryValue / annualRevenue) * 100 : 0;

  const delayedPOs = pos.filter((p) => p.status === "Delayed").length;
  const delayedProd = prod.filter((p) => p.status === "Delayed").length;
  const atRiskProd = prod.filter((p) => p.status === "At Risk").length;

  const cashInFG = inventoryValue;
  const cashInTransit = skus.reduce((a, s) => a + s.inTransit * s.landedCost, 0);
  const cashInProduction = skus.reduce((a, s) => a + s.inProduction * s.landedCost, 0);
  const cashInDead = deadStockValue;
  const cashInExcess = overstockValue;
  const totalCapital = cashInFG + cashInTransit + cashInProduction;
  const cashAtRisk = cashInDead + cashInExcess;

  const lostSalesSkus = stockoutRiskSkus.map((s) => {
    const daysOut = Math.max(0, s.leadTime - s.daysOfCover);
    const lostUnits = Math.round(daysOut * s.velocity);
    return { ...s, lostUnits, lostRevenue: lostUnits * s.price };
  }).sort((a, b) => b.lostRevenue - a.lostRevenue);
  const totalLostRevenue = lostSalesSkus.reduce((a, s) => a + s.lostRevenue, 0);

  return {
    totalUnits, inventoryValue, sellableValue, reservedUnits, damagedUnits, qcHoldUnits, returnedUnits,
    inTransitUnits, inProductionUnits, annualRevenue, annualCogs, daysOfInventory, turnover, weeksOfSupply,
    sellThroughAgg, stockoutRate, stockoutSkuCount, deadStockValue, deadStockPct, ageingPct, ageingValue90plus,
    overstockValue, overstockSkus, stockoutRiskSkus, forecastAccuracy, wmape, overForecastBias, underForecastBias,
    gmroi, invValuePctSales, delayedPOs, delayedProd, atRiskProd, cashInFG, cashInTransit, cashInProduction,
    cashInDead, cashInExcess, totalCapital, cashAtRisk, lostSalesSkus, totalLostRevenue, sales30Total, sales7Total,
  };
}

/* -------------------------------- ABC x XYZ matrix -------------------------------- */
function buildAbcXyzMatrix(skus) {
  const cells = {};
  ["A", "B", "C"].forEach((a) => ["X", "Y", "Z"].forEach((x) => { cells[a + x] = { count: 0, value: 0 }; }));
  skus.forEach((s) => {
    const key = s.abc + s.xyz;
    cells[key].count += 1;
    cells[key].value += s.currentStock * s.landedCost;
  });
  return cells;
}

const ABCXYZ_STRATEGY = {
  AX: "High value, predictable \u2013 replenish aggressively, tightest reorder discipline.",
  AY: "High value, some swings \u2013 keep close watch, moderate safety stock.",
  AZ: "High value, unpredictable \u2013 forecast carefully, protect with safety stock, don't over-commit.",
  BX: "Steady mid-tier \u2013 standard replenishment cadence.",
  BY: "Mid-tier, variable \u2013 review monthly, adjust safety stock.",
  BZ: "Mid-tier, erratic \u2013 buy conservatively, expect surprises.",
  CX: "Low value, predictable \u2013 simple, infrequent reordering.",
  CY: "Low value, some variability \u2013 light-touch monitoring only.",
  CZ: "Low value, unpredictable \u2013 avoid tying up capital here.",
};

/* -------------------------------- dead-stock workflow -------------------------------- */
const DEAD_STATUSES = ["Identified", "Review", "Action Required", "Clearance", "Markdown", "Write-off"];
function buildDeadStockWorkflow(skus) {
  return skus.filter((s) => s.isDead).map((s) => ({
    ...s, workflowStatus: pick(DEAD_STATUSES),
    recoveryPct: ri(20, 65),
  }));
}

/* ============================================================================
   SHARED UI PRIMITIVES
   ========================================================================= */

const TONE = {
  critical: { text: "text-rose-700", bg: "bg-rose-50", border: "border-rose-200", dot: "bg-rose-500", solidBg: "bg-rose-600" },
  attention: { text: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200", dot: "bg-amber-500", solidBg: "bg-amber-500" },
  healthy: { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", dot: "bg-emerald-500", solidBg: "bg-emerald-600" },
  info: { text: "text-sky-700", bg: "bg-sky-50", border: "border-sky-200", dot: "bg-sky-500", solidBg: "bg-sky-600" },
  neutral: { text: "text-slate-600", bg: "bg-slate-100", border: "border-slate-200", dot: "bg-slate-400", solidBg: "bg-slate-500" },
  brand: { text: "text-indigo-950", bg: "bg-indigo-50", border: "border-indigo-200", dot: "bg-indigo-700", solidBg: "bg-indigo-950" },
};

function Pill({ tone = "neutral", children, className = "" }) {
  const t = TONE[tone] || TONE.neutral;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border ${t.border} ${t.bg} ${t.text} px-2.5 py-1 text-[11px] font-semibold tracking-wide whitespace-nowrap ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  );
}

function classificationTone(bucket) {
  if (bucket === "BUY NOW") return "critical";
  if (bucket === "BUY SOON") return "attention";
  if (bucket === "MONITOR") return "info";
  if (bucket === "DO NOT BUY") return "neutral";
  if (bucket.startsWith("OVERSTOCK")) return "neutral";
  return "neutral";
}

function TrendArrow({ direction }) {
  if (direction === "up") return <ArrowUpRight className="h-3.5 w-3.5" />;
  if (direction === "down") return <ArrowDownRight className="h-3.5 w-3.5" />;
  return <Minus className="h-3.5 w-3.5" />;
}

function trendColor(direction, goodDirection) {
  if (direction === "flat") return "text-slate-400";
  const isGood = direction === goodDirection;
  return isGood ? "text-emerald-600" : "text-rose-600";
}

function SectionCard({ title, subtitle, action, children, className = "" }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white ${className}`}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            {title && <h3 className="font-display text-[15px] font-semibold text-slate-900">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-[12.5px] text-slate-500">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

function StatCard({ label, value, sub, tone = "neutral", icon: Icon }) {
  const t = TONE[tone] || TONE.neutral;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
      <div className="flex items-center justify-between">
        <div className="text-[11.5px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
        {Icon && <Icon className={`h-4 w-4 ${t.text}`} />}
      </div>
      <div className="mt-1.5 font-mono text-[22px] font-semibold leading-none text-slate-900">{value}</div>
      {sub && <div className="mt-1.5 text-[12px] text-slate-500">{sub}</div>}
    </div>
  );
}

function HealthMetric({ label, value, trend = "flat", goodDirection = "up", formula }) {
  return (
    <div className="group relative rounded-lg border border-slate-200 bg-white px-3.5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-[18px] font-semibold text-slate-900">{value}</span>
        <span className={`flex items-center ${trendColor(trend, goodDirection)}`}>
          <TrendArrow direction={trend} />
        </span>
      </div>
      {formula && (
        <div className="pointer-events-none absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-slate-900 px-2.5 py-2 text-[11px] leading-snug text-slate-100 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
          {formula}
        </div>
      )}
    </div>
  );
}

function useSortedRows(rows, initialKey, initialDir = "desc") {
  const [sortKey, setSortKey] = useState(initialKey);
  const [sortDir, setSortDir] = useState(initialDir);
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (typeof av === "string") { av = av.toLowerCase(); bv = (bv || "").toLowerCase(); }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, sortKey, sortDir]);
  const requestSort = (key) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  };
  return [sorted, sortKey, sortDir, requestSort];
}

function Th({ label, sortKey, activeKey, dir, onSort, align = "left", className = "" }) {
  const active = sortKey === activeKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`cursor-pointer select-none whitespace-nowrap px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-800 ${align === "right" ? "text-right" : "text-left"} ${className}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && <ChevronDown className={`h-3 w-3 transition-transform ${dir === "asc" ? "rotate-180" : ""}`} />}
      </span>
    </th>
  );
}

function Pagination({ page, setPage, total, pageSize }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-[12.5px] text-slate-500">
      <span>Page {page + 1} of {pages} \u00b7 {total} rows</span>
      <div className="flex gap-1.5">
        <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
          className="rounded-md border border-slate-200 px-2.5 py-1 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">
          Prev
        </button>
        <button onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}
          className="rounded-md border border-slate-200 px-2.5 py-1 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">
          Next
        </button>
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
        active ? "border-indigo-950 bg-indigo-950 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ text }) {
  return <div className="px-5 py-10 text-center text-[13px] text-slate-400">{text}</div>;
}

/* ============================================================================
   TAB 1 — COMMAND CENTER
   ========================================================================= */
function CommandCenterTab({ skus, agg, pos, prod }) {
  const byLocation = [
    { name: "Main FC \u2013 Bhiwandi", units: skus.reduce((a, s) => a + Math.max(0, s.currentStock - s.qcHold - s.damaged), 0), tone: "brand" },
    { name: "In Transit", units: agg.inTransitUnits, tone: "info" },
    { name: "In Production", units: agg.inProductionUnits, tone: "info" },
    { name: "Reserved (orders)", units: agg.reservedUnits, tone: "neutral" },
    { name: "QC Hold", units: agg.qcHoldUnits, tone: "attention" },
    { name: "Damaged", units: agg.damagedUnits, tone: "critical" },
    { name: "Returned (pending grade)", units: agg.returnedUnits, tone: "attention" },
  ];
  const maxLoc = Math.max(...byLocation.map((l) => l.units), 1);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">Inventory at a glance</h2>
        <p className="mt-1 text-[13px] text-slate-500">Every SKU, every location, landed cost basis \u00b7 as of {fmtDate(TODAY)}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label="Total inventory units" value={agg.totalUnits.toLocaleString("en-IN")} sub="Sellable + in-pipeline" tone="brand" icon={Boxes} />
        <StatCard label="Inventory value" value={fmtInr(agg.inventoryValue)} sub="At landed cost" tone="brand" icon={IndianRupee} />
        <StatCard label="Sellable inventory value" value={fmtInr(agg.sellableValue)} sub="Excl. reserved / damaged / QC hold" tone="healthy" icon={ShieldCheck} />
        <StatCard label="Inventory in transit" value={agg.inTransitUnits.toLocaleString("en-IN")} sub={`${fmtInr(skus.reduce((a, s) => a + s.inTransit * s.landedCost, 0))} in value`} tone="info" icon={Truck} />
        <StatCard label="Inventory in production" value={agg.inProductionUnits.toLocaleString("en-IN")} sub={`${prod.filter((p) => p.status !== "Delayed").length} orders on track`} tone="info" icon={Factory} />
        <StatCard label="Reserved (open orders)" value={agg.reservedUnits.toLocaleString("en-IN")} sub="Committed, not yet shipped" tone="neutral" icon={Package} />
        <StatCard label="Blocked / QC hold" value={agg.qcHoldUnits.toLocaleString("en-IN")} sub="Pending quality clearance" tone="attention" icon={CircleAlert} />
        <StatCard label="Returned + damaged" value={(agg.returnedUnits + agg.damagedUnits).toLocaleString("en-IN")} sub={`${agg.returnedUnits} returned \u00b7 ${agg.damagedUnits} damaged`} tone="critical" icon={CircleX} />
      </div>

      <SectionCard title="Key health metrics" subtitle="Hover a tile for the formula \u00b7 trend vs. last month">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          <HealthMetric label="Days of inventory" value={agg.daysOfInventory.toFixed(0) + "d"} trend="down" goodDirection="down" formula="Average inventory \u00f7 COGS \u00d7 365" />
          <HealthMetric label="Weeks of supply" value={agg.weeksOfSupply.toFixed(1) + "w"} trend="flat" goodDirection="down" formula="Total units \u00f7 average daily demand \u00f7 7" />
          <HealthMetric label="Inventory turnover" value={agg.turnover.toFixed(1) + "x"} trend="up" goodDirection="up" formula="COGS \u00f7 average inventory (annualized)" />
          <HealthMetric label="Sell-through (30d)" value={agg.sellThroughAgg.toFixed(1) + "%"} trend="up" goodDirection="up" formula="Units sold \u00f7 units received \u00d7 100" />
          <HealthMetric label="Stockout rate" value={agg.stockoutRate.toFixed(1) + "%"} trend="up" goodDirection="down" formula="SKUs at zero stock \u00f7 total active SKUs" />
          <HealthMetric label="Dead stock %" value={agg.deadStockPct.toFixed(1) + "%"} trend="up" goodDirection="down" formula="Dead stock value \u00f7 total inventory value" />
          <HealthMetric label="Ageing inventory %" value={agg.ageingPct.toFixed(1) + "%"} trend="up" goodDirection="down" formula="Value aged 90d+ \u00f7 total inventory value" />
          <HealthMetric label="Inventory accuracy" value="97.4%" trend="flat" goodDirection="up" formula="Correct records \u00f7 total records \u00b7 last cycle count Aug 24" />
          <HealthMetric label="Forecast accuracy" value={agg.forecastAccuracy.toFixed(0) + "%"} trend="down" goodDirection="up" formula={`100 \u2212 WMAPE (${agg.wmape.toFixed(1)}%), stockout-adjusted`} />
          <HealthMetric label="GMROI" value={"\u20B9" + agg.gmroi.toFixed(2)} trend="up" goodDirection="up" formula="Gross margin \u00f7 average inventory cost" />
          <HealthMetric label="Inv. value % of sales" value={agg.invValuePctSales.toFixed(1) + "%"} trend="flat" goodDirection="down" formula="Inventory value \u00f7 annualized revenue" />
          <HealthMetric label="Run-rate revenue" value={inrCr(agg.annualRevenue)} trend="up" goodDirection="up" formula="30-day sales \u00d7 12, at MRP \u00b7 target \u20B925 Cr" />
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Needs your attention today" subtitle="Full detail on the Needs Attention tab" className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3">
              <div className="text-[11px] font-medium uppercase text-rose-600">Stockout risk</div>
              <div className="mt-1 font-mono text-lg font-semibold text-rose-700">{agg.stockoutRiskSkus.length} SKUs</div>
              <div className="mt-0.5 text-[11.5px] text-rose-600">{fmtInr(agg.totalLostRevenue)} sales at risk</div>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3">
              <div className="text-[11px] font-medium uppercase text-amber-700">Overstock</div>
              <div className="mt-1 font-mono text-lg font-semibold text-amber-700">{agg.overstockSkus.length} SKUs</div>
              <div className="mt-0.5 text-[11.5px] text-amber-700">{fmtInr(agg.overstockValue)} excess</div>
            </div>
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3">
              <div className="text-[11px] font-medium uppercase text-rose-600">Dead stock</div>
              <div className="mt-1 font-mono text-lg font-semibold text-rose-700">{skus.filter((s) => s.isDead).length} SKUs</div>
              <div className="mt-0.5 text-[11.5px] text-rose-600">{fmtInr(agg.deadStockValue)} locked</div>
            </div>
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-3">
              <div className="text-[11px] font-medium uppercase text-sky-700">Production delays</div>
              <div className="mt-1 font-mono text-lg font-semibold text-sky-700">{agg.delayedProd + agg.atRiskProd} orders</div>
              <div className="mt-0.5 text-[11.5px] text-sky-700">{agg.delayedProd} delayed \u00b7 {agg.atRiskProd} at risk</div>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Inventory by location">
          <div className="space-y-2.5">
            {byLocation.map((l) => {
              const t = TONE[l.tone];
              return (
                <div key={l.name}>
                  <div className="mb-1 flex items-center justify-between text-[12px]">
                    <span className="text-slate-600">{l.name}</span>
                    <span className="font-mono font-medium text-slate-800">{l.units.toLocaleString("en-IN")}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className={`h-full rounded-full ${t.solidBg}`} style={{ width: `${(l.units / maxLoc) * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

/* ============================================================================
   TAB 2 — NEEDS ATTENTION
   ========================================================================= */
function StockoutRiskTable({ skus }) {
  const rows = skus.filter((s) => s.isStockoutRisk).map((s) => ({
    ...s, daysRemaining: Math.max(0, Math.floor(s.daysOfCover)),
  }));
  const [sorted, sortKey, dir, onSort] = useSortedRows(rows, "daysRemaining", "asc");
  if (!rows.length) return <EmptyState text="No SKUs are at stockout risk right now." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead className="border-b border-slate-200">
          <tr>
            <Th label="SKU" sortKey="sku" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Product / Variant" sortKey="product" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Stock" sortKey="currentStock" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Velocity/d" sortKey="velocity" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Days left" sortKey="daysRemaining" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Incoming" sortKey="incomingQty" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="ETA" sortKey="incomingEtaDays" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Stockout date" sortKey="stockoutEta" activeKey={sortKey} dir={dir} onSort={onSort} />
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Recommended action</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.sku} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2.5 font-mono text-[12px] text-slate-700">{s.sku}</td>
              <td className="px-3 py-2.5 text-slate-700">{s.product} <span className="text-slate-400">\u00b7 {s.color} \u00b7 {s.size}</span></td>
              <td className="px-3 py-2.5 text-right font-mono">{s.currentStock}</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.velocity.toFixed(1)}</td>
              <td className="px-3 py-2.5 text-right"><Pill tone={s.daysRemaining <= 7 ? "critical" : "attention"}>{s.daysRemaining}d</Pill></td>
              <td className="px-3 py-2.5 text-right font-mono">{s.incomingQty || "\u2013"}</td>
              <td className="px-3 py-2.5 text-slate-500">{s.incomingEtaDays ? `${s.incomingEtaDays}d` : "\u2013"}</td>
              <td className="px-3 py-2.5 text-slate-500">{s.stockoutEta ? fmtDate(s.stockoutEta) : "\u2013"}</td>
              <td className="px-3 py-2.5 text-slate-600">Raise PO with {s.manufacturer.split(",")[0]} today \u00b7 lead time {s.leadTime}d</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverstockTable({ skus }) {
  const rows = skus.filter((s) => s.isOverstock).map((s) => {
    const expectedDemand60 = Math.round(s.velocity * 60);
    const excessUnits = Math.max(0, s.currentStock - expectedDemand60);
    return { ...s, expectedDemand60, excessUnits, excessValue: excessUnits * s.landedCost };
  });
  const [sorted, sortKey, dir, onSort] = useSortedRows(rows, "excessValue", "desc");
  if (!rows.length) return <EmptyState text="No SKUs are meaningfully overstocked." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead className="border-b border-slate-200">
          <tr>
            <Th label="SKU" sortKey="sku" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Product / Variant" sortKey="product" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Current units" sortKey="currentStock" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Expected demand (60d)" sortKey="expectedDemand60" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Excess units" sortKey="excessUnits" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Excess value" sortKey="excessValue" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Days of cover" sortKey="daysOfCover" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Recommended action</th>
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 30).map((s) => (
            <tr key={s.sku} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2.5 font-mono text-[12px] text-slate-700">{s.sku}</td>
              <td className="px-3 py-2.5 text-slate-700">{s.product} <span className="text-slate-400">\u00b7 {s.color} \u00b7 {s.size}</span></td>
              <td className="px-3 py-2.5 text-right font-mono">{s.currentStock}</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.expectedDemand60}</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.excessUnits}</td>
              <td className="px-3 py-2.5 text-right font-mono font-medium text-amber-700">{fmtInr(s.excessValue)}</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.daysOfCover}d</td>
              <td className="px-3 py-2.5 text-slate-600">Pause replenishment \u00b7 consider bundle or markdown</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeadStockTable({ skus }) {
  const rows = skus.filter((s) => s.isDead);
  const [sorted, sortKey, dir, onSort] = useSortedRows(rows.map((s) => ({ ...s, value: s.currentStock * s.landedCost })), "value", "desc");
  if (!rows.length) return <EmptyState text="No dead stock detected." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead className="border-b border-slate-200">
          <tr>
            <Th label="SKU" sortKey="sku" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Product / Variant" sortKey="product" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Units" sortKey="currentStock" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Value" sortKey="value" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Last sale" sortKey="lastSaleDaysAgo" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Age bucket" sortKey="ageBucket" activeKey={sortKey} dir={dir} onSort={onSort} />
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Recommended action</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.sku} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2.5 font-mono text-[12px] text-slate-700">{s.sku}</td>
              <td className="px-3 py-2.5 text-slate-700">{s.product} <span className="text-slate-400">\u00b7 {s.color} \u00b7 {s.size}</span></td>
              <td className="px-3 py-2.5 text-right font-mono">{s.currentStock}</td>
              <td className="px-3 py-2.5 text-right font-mono font-medium text-rose-700">{fmtInr(s.value)}</td>
              <td className="px-3 py-2.5 text-right text-slate-500">{s.lastSaleDaysAgo}d ago</td>
              <td className="px-3 py-2.5"><Pill tone="critical">{s.ageBucket}d</Pill></td>
              <td className="px-3 py-2.5 text-slate-600">Bundle, markdown, or write off \u2013 see Ageing &amp; Cash tab</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SlowMoversTable({ skus }) {
  const rows = skus.filter((s) => s.isSlowMover);
  const [sorted, sortKey, dir, onSort] = useSortedRows(rows, "velocity", "asc");
  if (!rows.length) return <EmptyState text="No slow movers flagged." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead className="border-b border-slate-200">
          <tr>
            <Th label="SKU" sortKey="sku" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Product / Variant" sortKey="product" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Velocity/d" sortKey="velocity" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Expected/d (profile)" sortKey="profile" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Days of cover" sortKey="daysOfCover" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="XYZ" sortKey="xyz" activeKey={sortKey} dir={dir} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 25).map((s) => (
            <tr key={s.sku} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2.5 font-mono text-[12px] text-slate-700">{s.sku}</td>
              <td className="px-3 py-2.5 text-slate-700">{s.product} <span className="text-slate-400">\u00b7 {s.color} \u00b7 {s.size}</span></td>
              <td className="px-3 py-2.5 text-right font-mono">{s.velocity.toFixed(2)}</td>
              <td className="px-3 py-2.5 text-right text-slate-400">below plan</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.daysOfCover === 999 ? "\u2013" : s.daysOfCover + "d"}</td>
              <td className="px-3 py-2.5"><Pill tone={s.xyz === "Z" ? "critical" : "attention"}>{s.xyz}</Pill></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductionDelaysList({ prod }) {
  const rows = prod.filter((p) => p.status === "Delayed" || p.status === "At Risk");
  if (!rows.length) return <EmptyState text="No production delays right now." />;
  return (
    <div className="space-y-2.5">
      {rows.map((p) => (
        <div key={p.id} className={`flex items-center justify-between rounded-lg border px-4 py-3 ${p.status === "Delayed" ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"}`}>
          <div>
            <div className="text-[13px] font-medium text-slate-800">{p.id} \u00b7 {p.product}</div>
            <div className="mt-0.5 text-[12px] text-slate-500">{p.manufacturer} \u00b7 {p.planned.toLocaleString("en-IN")} units \u00b7 currently at {p.currentStage}</div>
          </div>
          <div className="text-right">
            <Pill tone={p.status === "Delayed" ? "critical" : "attention"}>{p.status}</Pill>
            <div className="mt-1 text-[12px] text-slate-500">Deadline {p.deadline} {p.deadlineDays < 0 ? `\u00b7 ${Math.abs(p.deadlineDays)}d overdue` : `\u00b7 ${p.deadlineDays}d left`}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CashAtRiskPanel({ skus, agg }) {
  const rows = [...skus.filter((s) => s.isDead), ...skus.filter((s) => s.isOverstock)]
    .map((s) => ({ ...s, lockedValue: s.currentStock * s.landedCost }))
    .sort((a, b) => b.lockedValue - a.lockedValue)
    .slice(0, 12);
  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Locked in dead stock" value={fmtInr(agg.deadStockValue)} tone="critical" icon={CircleX} />
        <StatCard label="Locked in overstock" value={fmtInr(agg.overstockValue)} tone="attention" icon={CircleAlert} />
        <StatCard label="Total cash at risk" value={fmtInr(agg.cashAtRisk)} sub={`${agg.invValuePctSales.toFixed(1)}% of run-rate revenue`} tone="critical" icon={IndianRupee} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="border-b border-slate-200">
            <tr>
              <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">SKU</th>
              <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Product</th>
              <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Units</th>
              <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Value locked</th>
              <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.sku} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2.5 font-mono text-[12px] text-slate-700">{s.sku}</td>
                <td className="px-3 py-2.5 text-slate-700">{s.product} <span className="text-slate-400">\u00b7 {s.color} \u00b7 {s.size}</span></td>
                <td className="px-3 py-2.5 text-right font-mono">{s.currentStock}</td>
                <td className="px-3 py-2.5 text-right font-mono font-medium text-rose-700">{fmtInr(s.lockedValue)}</td>
                <td className="px-3 py-2.5"><Pill tone={s.isDead ? "critical" : "attention"}>{s.isDead ? "Dead stock" : "Overstock"}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NeedsAttentionTab({ skus, agg, prod }) {
  const [active, setActive] = useState("stockout");
  const tabs = [
    { id: "stockout", label: `\uD83D\uDD34 Stockout risk (${agg.stockoutRiskSkus.length})` },
    { id: "overstock", label: `\uD83D\uDFE0 Overstock (${agg.overstockSkus.length})` },
    { id: "dead", label: `\uD83D\uDD34 Dead stock (${skus.filter((s) => s.isDead).length})` },
    { id: "slow", label: `\uD83D\uDFE1 Slow movers (${skus.filter((s) => s.isSlowMover).length})` },
    { id: "production", label: `\uD83D\uDD35 Production delays (${agg.delayedProd + agg.atRiskProd})` },
    { id: "cash", label: `\uD83D\uDFE3 Cash at risk` },
  ];
  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">What needs attention?</h2>
        <p className="mt-1 text-[13px] text-slate-500">Exception management, not dashboard-staring \u2014 this is the only list that matters today.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <FilterChip key={t.id} active={active === t.id} onClick={() => setActive(t.id)}>{t.label}</FilterChip>
        ))}
      </div>
      <SectionCard>
        {active === "stockout" && <StockoutRiskTable skus={skus} />}
        {active === "overstock" && <OverstockTable skus={skus} />}
        {active === "dead" && <DeadStockTable skus={skus} />}
        {active === "slow" && <SlowMoversTable skus={skus} />}
        {active === "production" && <ProductionDelaysList prod={prod} />}
        {active === "cash" && <CashAtRiskPanel skus={skus} agg={agg} />}
      </SectionCard>
    </div>
  );
}

/* ============================================================================
   TAB 3 — MASTER INVENTORY DATABASE
   ========================================================================= */
function statusForSku(s) {
  if (s.isDead) return { label: "Dead", tone: "critical" };
  if (s.currentStock === 0) return { label: "Out of stock", tone: "critical" };
  if (s.isStockoutRisk) return { label: "Stockout risk", tone: "critical" };
  if (s.isOverstock) return { label: "Overstock", tone: "attention" };
  if (s.isSlowMover) return { label: "Slow mover", tone: "attention" };
  return { label: "Healthy", tone: "healthy" };
}

function SkuDetailRow({ s }) {
  const rep = classifyReplenishment(s);
  const field = (label, value) => (
    <div>
      <div className="text-[10.5px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 font-mono text-[12.5px] text-slate-800">{value}</div>
    </div>
  );
  return (
    <tr className="border-b border-slate-100 bg-slate-50/70">
      <td colSpan={12} className="px-5 py-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:grid-cols-6">
          {field("Department / Category", `${s.dept} / ${s.category}`)}
          {field("Collection", s.collection)}
          {field("Supplier / Manufacturer", s.manufacturer)}
          {field("Warehouse / Bin", `${s.warehouse.split("\u2013")[0].trim()} \u00b7 ${s.storageBin}`)}
          {field("Unit cost / Landed cost", `${inr(s.unitCost)} / ${inr(s.landedCost)}`)}
          {field("MRP / Selling price", `${inr(s.mrp)} / ${inr(s.price)}`)}
          {field("Reserved / Damaged / QC hold", `${s.reserved} / ${s.damaged} / ${s.qcHold}`)}
          {field("In transit / In production", `${s.inTransit} / ${s.inProduction}`)}
          {field("7d / 14d / 30d / 60d / 90d sales", `${s.sales7} / ${s.sales14} / ${s.sales30} / ${s.sales60} / ${s.sales90}`)}
          {field("Lead time / Safety stock", `${s.leadTime}d / ${s.safetyStock}u`)}
          {field("Reorder point", `${s.reorderPoint}u`)}
          {field("Forecast (30d, base)", `${Math.round(s.velocity * 30)}u`)}
          {field("ABC / XYZ", `${s.abc}${s.xyz}`)}
          {field("Ageing", `${s.ageingDays}d \u00b7 bucket ${s.ageBucket}`)}
          {field("Last sale", `${s.lastSaleDate} (${s.lastSaleDaysAgo}d ago)`)}
          {field("Launch date", s.launch)}
          {field("Replenishment call", rep.bucket)}
        </div>
      </td>
    </tr>
  );
}

function MasterInventoryTab({ skus }) {
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("All");
  const [status, setStatus] = useState("All");
  const [abc, setAbc] = useState("All");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const pageSize = 20;

  const depts = ["All", ...new Set(skus.map((s) => s.dept))];
  const abcOptions = ["All", "A", "B", "C"];
  const statusOptions = ["All", "Healthy", "Stockout risk", "Out of stock", "Overstock", "Slow mover", "Dead"];

  const filtered = useMemo(() => {
    return skus.filter((s) => {
      if (dept !== "All" && s.dept !== dept) return false;
      if (abc !== "All" && s.abc !== abc) return false;
      if (status !== "All" && statusForSku(s).label !== status) return false;
      if (q) {
        const hay = `${s.sku} ${s.product} ${s.color} ${s.size} ${s.category}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [skus, dept, abc, status, q]);

  const [sorted, sortKey, dir, onSort] = useSortedRows(filtered, "seq", "asc");
  const pageRows = sorted.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">Master inventory database</h2>
        <p className="mt-1 text-[13px] text-slate-500">One row per SKU \u00d7 colour \u00d7 size \u2014 {skus.length} SKUs tracked. Click a row for the full field set.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Search SKU, product, colour..."
            className="w-64 rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-[13px] outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200"
          />
        </div>
        <select value={dept} onChange={(e) => { setDept(e.target.value); setPage(0); }} className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-600 outline-none focus:border-indigo-400">
          {depts.map((d) => <option key={d}>{d}</option>)}
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-600 outline-none focus:border-indigo-400">
          {statusOptions.map((d) => <option key={d}>{d}</option>)}
        </select>
        <select value={abc} onChange={(e) => { setAbc(e.target.value); setPage(0); }} className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-600 outline-none focus:border-indigo-400">
          {abcOptions.map((d) => <option key={d}>{d === "All" ? "All ABC" : `Class ${d}`}</option>)}
        </select>
        <span className="ml-auto text-[12.5px] text-slate-400">{filtered.length} matching</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <Th label="SKU" sortKey="sku" activeKey={sortKey} dir={dir} onSort={onSort} />
                <Th label="Product" sortKey="product" activeKey={sortKey} dir={dir} onSort={onSort} />
                <Th label="Colour / Size" sortKey="color" activeKey={sortKey} dir={dir} onSort={onSort} />
                <Th label="Stock" sortKey="currentStock" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
                <Th label="Incoming" sortKey="incomingQty" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
                <Th label="Vel/d" sortKey="velocity" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
                <Th label="Cover" sortKey="daysOfCover" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
                <Th label="Sell-thru 30d" sortKey="sellThrough30" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
                <Th label="ABC/XYZ" sortKey="abc" activeKey={sortKey} dir={dir} onSort={onSort} />
                <Th label="Value" sortKey="landedCost" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Status</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((s) => {
                const st = statusForSku(s);
                const isOpen = expanded === s.sku;
                return (
                  <React.Fragment key={s.sku}>
                    <tr onClick={() => setExpanded(isOpen ? null : s.sku)} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2.5 font-mono text-[12px] text-slate-700">{s.sku}</td>
                      <td className="px-3 py-2.5 text-slate-700">{s.product}</td>
                      <td className="px-3 py-2.5 text-slate-500">{s.color} \u00b7 {s.size}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{s.currentStock}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-500">{s.incomingQty || "\u2013"}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{s.velocity.toFixed(1)}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{s.daysOfCover === 999 ? "\u2013" : s.daysOfCover}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{s.sellThrough30}%</td>
                      <td className="px-3 py-2.5"><span className="font-mono text-[12px] text-slate-500">{s.abc}{s.xyz}</span></td>
                      <td className="px-3 py-2.5 text-right font-mono">{fmtInr(s.currentStock * s.landedCost)}</td>
                      <td className="px-3 py-2.5"><Pill tone={st.tone}>{st.label}</Pill></td>
                      <td className="px-3 py-2.5 text-slate-300">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                    </tr>
                    {isOpen && <SkuDetailRow s={s} />}
                  </React.Fragment>
                );
              })}
              {!pageRows.length && (
                <tr><td colSpan={12}><EmptyState text="No SKUs match these filters." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={page} setPage={setPage} total={filtered.length} pageSize={pageSize} />
      </div>
    </div>
  );
}

/* ============================================================================
   TAB 4 — REPLENISHMENT, PURCHASE ORDERS & PRODUCTION
   ========================================================================= */
const PO_STATUS_TONE = { "Open": "info", "Partially Received": "attention", "Fully Received": "healthy", "Delayed": "critical", "Cancelled": "neutral" };
const PROD_STAGES = ["Cutting", "Stitching", "Finishing", "QC", "Packing", "Dispatched"];

function ReplenishmentTable({ skus }) {
  const [filter, setFilter] = useState("BUY NOW");
  const rows = useMemo(() => skus.map((s) => ({ ...s, rep: classifyReplenishment(s) })), [skus]);
  const buckets = ["BUY NOW", "BUY SOON", "MONITOR", "DO NOT BUY", "OVERSTOCK \u2013 DO NOT REPLENISH"];
  const counts = Object.fromEntries(buckets.map((b) => [b, rows.filter((r) => r.rep.bucket === b)]));
  const filtered = counts[filter] || [];
  const [sorted, sortKey, dir, onSort] = useSortedRows(filtered.map((r) => ({ ...r, purchaseValue: r.rep.purchaseValue, daysRemaining: r.daysOfCover === 999 ? 9999 : r.daysOfCover })), "purchaseValue", "desc");

  const buyNowValue = counts["BUY NOW"].reduce((a, r) => a + r.rep.purchaseValue, 0);
  const buySoonValue = counts["BUY SOON"].reduce((a, r) => a + r.rep.purchaseValue, 0);
  const holdValue = counts["MONITOR"].reduce((a, r) => a + r.currentStock * r.landedCost, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Buy now" value={fmtInr(buyNowValue)} sub={`${counts["BUY NOW"].length} SKUs \u00b7 critical`} tone="critical" />
        <StatCard label="Buy soon" value={fmtInr(buySoonValue)} sub={`${counts["BUY SOON"].length} SKUs`} tone="attention" />
        <StatCard label="Already sufficient (hold)" value={fmtInr(holdValue)} sub={`${counts["MONITOR"].length} SKUs`} tone="healthy" />
      </div>
      <div className="flex flex-wrap gap-2">
        {buckets.map((b) => (
          <FilterChip key={b} active={filter === b} onClick={() => setFilter(b)}>{b} ({counts[b].length})</FilterChip>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="border-b border-slate-200">
            <tr>
              <Th label="SKU" sortKey="sku" activeKey={sortKey} dir={dir} onSort={onSort} />
              <Th label="Product / Variant" sortKey="product" activeKey={sortKey} dir={dir} onSort={onSort} />
              <Th label="Stock" sortKey="currentStock" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
              <Th label="Vel/d" sortKey="velocity" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
              <Th label="Cover" sortKey="daysRemaining" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
              <Th label="Lead time" sortKey="leadTime" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
              <Th label="Rec. qty" sortKey="recommendedQty" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
              <Th label="Est. value" sortKey="purchaseValue" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
              <Th label="Priority" sortKey="priority" activeKey={sortKey} dir={dir} onSort={onSort} />
              <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Reason</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 40).map((s) => (
              <tr key={s.sku} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2.5 font-mono text-[12px] text-slate-700">{s.sku}</td>
                <td className="px-3 py-2.5 text-slate-700">{s.product} <span className="text-slate-400">\u00b7 {s.color} \u00b7 {s.size}</span></td>
                <td className="px-3 py-2.5 text-right font-mono">{s.currentStock}</td>
                <td className="px-3 py-2.5 text-right font-mono">{s.velocity.toFixed(1)}</td>
                <td className="px-3 py-2.5 text-right font-mono">{s.daysOfCover === 999 ? "\u2013" : s.daysOfCover + "d"}</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-500">{s.leadTime}d</td>
                <td className="px-3 py-2.5 text-right font-mono font-medium">{s.rep.recommendedQty || "\u2013"}</td>
                <td className="px-3 py-2.5 text-right font-mono">{s.rep.recommendedQty ? fmtInr(s.rep.purchaseValue) : "\u2013"}</td>
                <td className="px-3 py-2.5"><Pill tone={classificationTone(s.rep.bucket)}>{s.rep.priority}</Pill></td>
                <td className="px-3 py-2.5 text-slate-600">{s.rep.reason}</td>
              </tr>
            ))}
            {!sorted.length && <tr><td colSpan={10}><EmptyState text="Nothing in this bucket." /></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PoPipeline({ pos }) {
  const [filter, setFilter] = useState("All");
  const statuses = ["All", "Open", "Partially Received", "Fully Received", "Delayed", "Cancelled"];
  const rows = filter === "All" ? pos : pos.filter((p) => p.status === filter);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {statuses.map((s) => (
          <FilterChip key={s} active={filter === s} onClick={() => setFilter(s)}>
            {s} {s !== "All" ? `(${pos.filter((p) => p.status === s).length})` : ""}
          </FilterChip>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full border-collapse text-[13px]">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {["PO ID", "Product", "Manufacturer", "Ordered", "Received", "Balance", "Expected", "Actual", "Delay", "Status"].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.poId} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2.5 font-mono text-[12px] text-slate-700">{p.poId}</td>
                <td className="px-3 py-2.5 text-slate-700">{p.product}</td>
                <td className="px-3 py-2.5 text-slate-500">{p.manufacturer}</td>
                <td className="px-3 py-2.5 text-right font-mono">{p.orderQty}</td>
                <td className="px-3 py-2.5 text-right font-mono">{p.receivedQty}</td>
                <td className="px-3 py-2.5 text-right font-mono">{p.balance}</td>
                <td className="px-3 py-2.5 text-slate-500">{p.expectedDate}</td>
                <td className="px-3 py-2.5 text-slate-500">{p.actualDate}</td>
                <td className="px-3 py-2.5 text-right font-mono">{p.daysDelayed ? `${p.daysDelayed}d` : "\u2013"}</td>
                <td className="px-3 py-2.5"><Pill tone={PO_STATUS_TONE[p.status]}>{p.status}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProductionPipeline({ prod }) {
  return (
    <div className="space-y-3">
      {prod.map((p) => {
        const stageIdx = PROD_STAGES.indexOf(p.currentStage);
        return (
          <div key={p.id} className="rounded-lg border border-slate-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-mono text-[12px] text-slate-500">{p.id}</span>
                <span className="ml-2 text-[13.5px] font-medium text-slate-800">{p.product}</span>
                <span className="ml-2 text-[12px] text-slate-400">{p.manufacturer}</span>
              </div>
              <Pill tone={p.status === "Delayed" ? "critical" : p.status === "At Risk" ? "attention" : "healthy"}>{p.status}</Pill>
            </div>
            <div className="mt-3 flex items-center gap-1">
              {PROD_STAGES.map((stage, i) => (
                <div key={stage} className="flex flex-1 flex-col items-center gap-1">
                  <div className={`h-1.5 w-full rounded-full ${i <= stageIdx ? (p.status === "Delayed" ? "bg-rose-500" : "bg-indigo-900") : "bg-slate-100"}`} />
                  <span className={`text-[10px] ${i <= stageIdx ? "text-slate-600" : "text-slate-300"}`}>{stage}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-slate-500">
              <span>Planned <b className="font-mono text-slate-700">{p.planned}</b></span>
              <span>QC passed <b className="font-mono text-slate-700">{p.qcPassed}</b></span>
              <span>Packed <b className="font-mono text-slate-700">{p.packed}</b></span>
              <span>Dispatched <b className="font-mono text-slate-700">{p.dispatched}</b></span>
              <span>Started {p.productionStart}</span>
              <span>Deadline {p.deadline}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SupplierScorecard({ suppliers }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full border-collapse text-[13px]">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            {["Manufacturer", "Orders", "On-time %", "Rejection %", "Shortage %", "Avg lead time", "Lead time var.", "Cost var.", "Status"].map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {suppliers.map((s) => (
            <tr key={s.id} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2.5 text-slate-700">{s.name}</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.orders}</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.onTimePct}%</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.rejectionPct}%</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.shortagePct}%</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.avgLeadTime}d</td>
              <td className="px-3 py-2.5 text-right font-mono">\u00b1{s.leadTimeVariance}d</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.costVariancePct > 0 ? "+" : ""}{s.costVariancePct}%</td>
              <td className="px-3 py-2.5"><Pill tone={s.tone}>{s.tone === "healthy" ? "Reliable" : s.tone === "attention" ? "Watch" : "Risk"}</Pill></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RawMaterialPanel({ rawMaterials }) {
  const [qty, setQty] = useState(1000);
  // Ringer Tee BOM: fabric (0.18kg/unit), rib (0.03kg/unit), label (1pc), care label (1pc), thread (0.02 cone/unit), polybag (1pc), carton (1 per 20 units)
  const bom = [
    { name: "Cotton Single Jersey Fabric (Black)", per: 0.18 },
    { name: "Rib Fabric \u2013 Collar/Cuff", per: 0.03 },
    { name: "Woven Main Label", per: 1 },
    { name: "Care Label", per: 1 },
    { name: "Sewing Thread \u2013 Cone", per: 0.02 },
    { name: "Polybag \u2013 Branded", per: 1 },
  ];
  const feasibility = bom.map((b) => {
    const rm = rawMaterials.find((r) => r.name === b.name);
    const needed = Math.ceil(qty * b.per);
    const canMake = rm ? Math.floor(rm.closing / b.per) : 0;
    return { ...b, unit: rm?.unit, available: rm?.closing ?? 0, needed, canMake, short: rm ? rm.closing < needed : true };
  });
  const maxUnits = Math.min(...feasibility.map((f) => f.canMake));
  const bottleneck = feasibility.find((f) => f.canMake === maxUnits);

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full border-collapse text-[13px]">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {["Material", "Opening", "Inward", "Consumption", "Wastage", "Closing", "Min stock", "Supplier", "Status"].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rawMaterials.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2.5 text-slate-700">{r.name}</td>
                <td className="px-3 py-2.5 text-right font-mono">{r.opening}</td>
                <td className="px-3 py-2.5 text-right font-mono">{r.inward}</td>
                <td className="px-3 py-2.5 text-right font-mono">{r.consumption}</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-400">{r.wastage}</td>
                <td className="px-3 py-2.5 text-right font-mono font-medium">{r.closing} {r.unit}</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-400">{r.minStock}</td>
                <td className="px-3 py-2.5 text-slate-500">{r.supplier.split(",")[0]}</td>
                <td className="px-3 py-2.5"><Pill tone={r.belowMin ? "critical" : "healthy"}>{r.belowMin ? "Below min" : "OK"}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="font-display text-[14px] font-semibold text-indigo-950">Production feasibility check \u2014 Ringer Tee 001</h4>
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-slate-600">Can we produce</span>
            <input type="number" value={qty} onChange={(e) => setQty(Math.max(0, +e.target.value))} className="w-24 rounded-md border border-slate-300 px-2 py-1 font-mono text-[13px]" />
            <span className="text-slate-600">units?</span>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {feasibility.map((f) => (
            <div key={f.name} className={`rounded-md border px-2.5 py-2 ${f.short ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-white"}`}>
              <div className="truncate text-[10.5px] text-slate-500" title={f.name}>{f.name}</div>
              <div className="mt-0.5 font-mono text-[12.5px] font-medium text-slate-800">{f.canMake.toLocaleString("en-IN")} u max</div>
            </div>
          ))}
        </div>
        <div className={`mt-3 rounded-md px-3 py-2.5 text-[13px] font-medium ${maxUnits >= qty ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>
          {maxUnits >= qty
            ? `Yes \u2014 raw material on hand supports ${maxUnits.toLocaleString("en-IN")} units, comfortably above the ${qty.toLocaleString("en-IN")} requested.`
            : `Not yet \u2014 raw material only supports ${maxUnits.toLocaleString("en-IN")} units (bottleneck: ${bottleneck?.name}). Short by ${(qty - maxUnits).toLocaleString("en-IN")} units.`}
        </div>
      </div>
    </div>
  );
}

function CampaignReadiness({ campaigns }) {
  const toneFor = { Ready: "healthy", Risk: "attention", "Not Ready": "critical" };
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {campaigns.map((c) => (
        <div key={c.name} className="rounded-lg border border-slate-200 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[13px] font-medium text-slate-800">{c.name}</div>
            <Pill tone={toneFor[c.readiness]}>{c.readiness === "Ready" ? "\uD83D\uDFE2 Ready" : c.readiness === "Risk" ? "\uD83D\uDFE1 Risk" : "\uD83D\uDD34 Not ready"}</Pill>
          </div>
          <div className="mt-2 text-[12px] text-slate-500">{c.product} \u00b7 starts {c.startDate} \u00b7 +{c.upliftPct}% uplift</div>
          <div className="mt-2 flex justify-between text-[12px]">
            <span className="text-slate-500">Forecast demand</span>
            <span className="font-mono text-slate-700">{c.forecastUnits.toLocaleString("en-IN")}u</span>
          </div>
          <div className="flex justify-between text-[12px]">
            <span className="text-slate-500">Available (stock + incoming)</span>
            <span className="font-mono text-slate-700">{c.available.toLocaleString("en-IN")}u</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReplenishmentTab({ skus, pos, prod, rawMaterials, suppliers, campaigns }) {
  const [section, setSection] = useState("buy");
  const sections = [
    { id: "buy", label: "What should we buy?" },
    { id: "po", label: "Purchase order pipeline" },
    { id: "prod", label: "Production pipeline" },
    { id: "materials", label: "Raw materials & feasibility" },
    { id: "suppliers", label: "Supplier scorecard" },
    { id: "campaigns", label: "Campaign readiness" },
  ];
  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">Buying &amp; production</h2>
        <p className="mt-1 text-[13px] text-slate-500">From "what should we buy" to raw material feasibility \u2014 the founder's main decision screen.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {sections.map((s) => (
          <FilterChip key={s.id} active={section === s.id} onClick={() => setSection(s.id)}>{s.label}</FilterChip>
        ))}
      </div>
      <SectionCard>
        {section === "buy" && <ReplenishmentTable skus={skus} />}
        {section === "po" && <PoPipeline pos={pos} />}
        {section === "prod" && <ProductionPipeline prod={prod} />}
        {section === "materials" && <RawMaterialPanel rawMaterials={rawMaterials} />}
        {section === "suppliers" && <SupplierScorecard suppliers={suppliers} />}
        {section === "campaigns" && <CampaignReadiness campaigns={campaigns} />}
      </SectionCard>
    </div>
  );
}

/* ============================================================================
   TAB 5 — FORECAST & SEGMENTATION
   ========================================================================= */
const SCENARIOS = {
  Base: { mult: 1, color: "#312e81", label: "Base case" },
  Upside: { mult: 1.25, color: "#0284c7", label: "Upside" },
  Downside: { mult: 0.78, color: "#dc2626", label: "Downside" },
  Campaign: { mult: 1.3, color: "#d97706", label: "Campaign (+30%)" },
};

function buildForecastSeries(rows, horizonDays, scenarioKey) {
  const weeks = Array.from({ length: 12 }, (_, i) => {
    const total = rows.reduce((a, s) => a + s.weeklySales[i], 0);
    return { idx: i - 11, label: `W${i - 11}`, actual: total, forecast: null };
  });
  const lastActual = weeks[weeks.length - 1].actual;
  const baseWeeklyForecast = rows.reduce((a, s) => a + weightedMovingForecast(s.weeklySales), 0);
  const mult = SCENARIOS[scenarioKey].mult;
  const horizonWeeks = Math.max(1, Math.ceil(horizonDays / 7));
  weeks[weeks.length - 1] = { ...weeks[weeks.length - 1], forecast: lastActual };
  const future = Array.from({ length: horizonWeeks }, (_, i) => ({
    idx: i + 1, label: `W+${i + 1}`, actual: null,
    forecast: Math.round(baseWeeklyForecast * mult * (1 + (rand() - 0.5) * 0.06)),
  }));
  return [...weeks, ...future];
}

function ForecastChart({ skus }) {
  const productOptions = PRODUCTS.map((p) => ({ id: p.id, name: p.name }));
  const [productId, setProductId] = useState(productOptions[0].id);
  const [horizon, setHorizon] = useState(30);
  const [scenario, setScenario] = useState("Base");

  const rows = skus.filter((s) => s.productId === productId);
  const series = useMemo(() => buildForecastSeries(rows, horizon, scenario), [productId, horizon, scenario]);
  const horizonUnits = series.filter((w) => w.actual === null).reduce((a, w) => a + (w.forecast || 0), 0);
  const stockoutDaysNote = rows.some((s) => s.currentStock === 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <select value={productId} onChange={(e) => setProductId(e.target.value)} className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-700 outline-none focus:border-indigo-400">
          {productOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="flex gap-1">
          {[7, 14, 30, 60, 90].map((h) => (
            <FilterChip key={h} active={horizon === h} onClick={() => setHorizon(h)}>{h}D</FilterChip>
          ))}
        </div>
        <div className="ml-auto flex gap-1">
          {Object.keys(SCENARIOS).map((s) => (
            <FilterChip key={s} active={scenario === s} onClick={() => setScenario(s)}>{SCENARIOS[s].label}</FilterChip>
          ))}
        </div>
      </div>

      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef0f4" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }} />
            <ReferenceLine x="W0" stroke="#cbd5e1" strokeDasharray="4 4" label={{ value: "Today", position: "insideTopRight", fontSize: 10, fill: "#94a3b8" }} />
            <Line type="monotone" dataKey="actual" name="Actual (weekly units)" stroke="#0f172a" strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="forecast" name={SCENARIOS[scenario].label} stroke={SCENARIOS[scenario].color} strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-[12.5px] text-slate-600">
        <span><b className="font-mono text-slate-800">{horizonUnits.toLocaleString("en-IN")}</b> units forecast over next {horizon}d under {SCENARIOS[scenario].label.toLowerCase()}</span>
        {stockoutDaysNote && <span className="text-amber-700">Note: demand is stockout-adjusted \u2014 zero-stock days aren't treated as zero demand.</span>}
      </div>
    </div>
  );
}

function AbcXyzMatrix({ matrix }) {
  const rows = ["A", "B", "C"];
  const cols = ["X", "Y", "Z"];
  const toneMap = { AX: "healthy", AY: "info", AZ: "attention", BX: "info", BY: "neutral", BZ: "attention", CX: "neutral", CY: "neutral", CZ: "critical" };
  return (
    <div>
      <div className="grid grid-cols-3 gap-2.5">
        {rows.map((r) => cols.map((c) => {
          const key = r + c;
          const cell = matrix[key];
          const t = TONE[toneMap[key]];
          return (
            <div key={key} className={`rounded-lg border ${t.border} ${t.bg} p-3`}>
              <div className={`text-[13px] font-bold ${t.text}`}>{key}</div>
              <div className="mt-1 font-mono text-[16px] font-semibold text-slate-900">{cell.count} <span className="text-[11px] font-normal text-slate-500">SKUs</span></div>
              <div className="text-[11.5px] text-slate-500">{fmtInr(cell.value)}</div>
              <div className="mt-1.5 text-[11px] leading-snug text-slate-500">{ABCXYZ_STRATEGY[key]}</div>
            </div>
          );
        }))}
      </div>
      <p className="mt-3 text-[12px] text-slate-400">Rows: revenue contribution (A = highest). Columns: demand predictability (X = stable, Z = erratic).</p>
    </div>
  );
}

function SizeCurveChart({ skus }) {
  const productOptions = PRODUCTS.filter((p) => p.profile !== "dead");
  const [productId, setProductId] = useState(productOptions[0].id);
  const rows = skus.filter((s) => s.productId === productId);
  const sizes = [...new Set(rows.map((s) => s.size))];
  const orderRef = ["XS", "S", "M", "L", "XL", "XXL"];
  sizes.sort((a, b) => orderRef.indexOf(a) - orderRef.indexOf(b));
  const totalStock = rows.reduce((a, s) => a + s.currentStock, 0) || 1;
  const totalSales = rows.reduce((a, s) => a + s.sales30, 0) || 1;
  const data = sizes.map((size) => {
    const stock = rows.filter((s) => s.size === size).reduce((a, s) => a + s.currentStock, 0);
    const sales = rows.filter((s) => s.size === size).reduce((a, s) => a + s.sales30, 0);
    const stockPct = +((stock / totalStock) * 100).toFixed(0);
    const salesPct = +((sales / totalSales) * 100).toFixed(0);
    return { size, "Stock mix %": stockPct, "Sales mix %": salesPct, mismatch: Math.abs(stockPct - salesPct) };
  });
  const worst = [...data].sort((a, b) => b.mismatch - a.mismatch)[0];

  return (
    <div className="space-y-3">
      <select value={productId} onChange={(e) => setProductId(e.target.value)} className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-700 outline-none focus:border-indigo-400">
        {productOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef0f4" vertical={false} />
            <XAxis dataKey="size" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} unit="%" />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Stock mix %" fill="#94a3b8" radius={[3, 3, 0, 0]} />
            <Bar dataKey="Sales mix %" fill="#312e81" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {worst && worst.mismatch >= 6 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-800">
          Size mismatch flagged: <b>{worst.size}</b> is {worst["Sales mix %"] > worst["Stock mix %"] ? "under-bought" : "over-bought"} vs demand ({worst["Stock mix %"]}% of stock vs {worst["Sales mix %"]}% of sales). Skew the next buy toward the sizes with the biggest gap.
        </div>
      )}
    </div>
  );
}

function ForecastTab({ skus, matrix }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">Forecast &amp; segmentation</h2>
        <p className="mt-1 text-[13px] text-slate-500">What will we need \u2014 and which SKUs deserve the tightest management.</p>
      </div>
      <SectionCard title="Demand forecast" subtitle="Weighted off the last 5 weeks so one unusual day can't swing the number">
        <ForecastChart skus={skus} />
      </SectionCard>
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="ABC \u00d7 XYZ segmentation" subtitle="Value contribution \u00d7 demand predictability">
          <AbcXyzMatrix matrix={matrix} />
        </SectionCard>
        <SectionCard title="Size curve mismatch" subtitle="Stock mix vs. sales mix by size">
          <SizeCurveChart skus={skus} />
        </SectionCard>
      </div>
    </div>
  );
}

/* ============================================================================
   TAB 6 — AGEING & CASH CONTROL
   ========================================================================= */
const AGE_BUCKETS = ["0\u201330", "31\u201360", "61\u201390", "91\u2013120", "121\u2013180", "180+"];

function AgeingChart({ skus }) {
  const data = AGE_BUCKETS.map((b) => {
    const rows = skus.filter((s) => s.ageBucket === b);
    return {
      bucket: b,
      units: rows.reduce((a, s) => a + s.currentStock, 0),
      value: Math.round(rows.reduce((a, s) => a + s.currentStock * s.landedCost, 0) / 1000),
    };
  });
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef0f4" vertical={false} />
          <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
          <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} unit="k" />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }} formatter={(v, name) => (name === "\u20B9 value (000s)" ? `\u20B9${v.toLocaleString("en-IN")}k` : v)} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar yAxisId="left" dataKey="units" name="Units" fill="#94a3b8" radius={[3, 3, 0, 0]} />
          <Bar yAxisId="right" dataKey="value" name="\u20B9 value (000s)" radius={[3, 3, 0, 0]}>
            {data.map((d, i) => <Cell key={i} fill={i >= 3 ? "#dc2626" : i >= 2 ? "#d97706" : "#312e81"} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const DEAD_STATUS_TONE = { Identified: "info", Review: "attention", "Action Required": "critical", Clearance: "attention", Markdown: "attention", "Write-off": "critical" };

function DeadStockWorkflowTable({ deadWorkflow }) {
  const [sorted, sortKey, dir, onSort] = useSortedRows(deadWorkflow.map((s) => ({ ...s, value: s.currentStock * s.landedCost, recoverable: s.currentStock * s.landedCost * (s.recoveryPct / 100) })), "value", "desc");
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead className="border-b border-slate-200">
          <tr>
            <Th label="SKU" sortKey="sku" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Product" sortKey="product" activeKey={sortKey} dir={dir} onSort={onSort} />
            <Th label="Units" sortKey="currentStock" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Value" sortKey="value" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Est. recovery" sortKey="recoverable" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
            <Th label="Workflow" sortKey="workflowStatus" activeKey={sortKey} dir={dir} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.sku} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2.5 font-mono text-[12px] text-slate-700">{s.sku}</td>
              <td className="px-3 py-2.5 text-slate-700">{s.product} <span className="text-slate-400">\u00b7 {s.color} \u00b7 {s.size}</span></td>
              <td className="px-3 py-2.5 text-right font-mono">{s.currentStock}</td>
              <td className="px-3 py-2.5 text-right font-mono text-rose-700">{fmtInr(s.value)}</td>
              <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{fmtInr(s.recoverable)} <span className="text-slate-400">({s.recoveryPct}%)</span></td>
              <td className="px-3 py-2.5"><Pill tone={DEAD_STATUS_TONE[s.workflowStatus]}>{s.workflowStatus}</Pill></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LostSalesTable({ agg }) {
  const rows = agg.lostSalesSkus.slice(0, 15);
  if (!rows.length) return <EmptyState text="No material lost sales from stockouts right now." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead className="border-b border-slate-200">
          <tr>
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">SKU</th>
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Product</th>
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Days short</th>
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Avg daily demand</th>
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Est. lost units</th>
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Est. lost revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.sku} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2.5 font-mono text-[12px] text-slate-700">{s.sku}</td>
              <td className="px-3 py-2.5 text-slate-700">{s.product} <span className="text-slate-400">\u00b7 {s.color} \u00b7 {s.size}</span></td>
              <td className="px-3 py-2.5 text-right font-mono">{Math.max(0, Math.round(s.leadTime - s.daysOfCover))}d</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.velocity.toFixed(1)}</td>
              <td className="px-3 py-2.5 text-right font-mono">{s.lostUnits}</td>
              <td className="px-3 py-2.5 text-right font-mono font-medium text-rose-700">{fmtInr(s.lostRevenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgeingCashTab({ skus, agg, deadWorkflow }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">Ageing &amp; cash control</h2>
        <p className="mt-1 text-[13px] text-slate-500">Understock costs revenue; overstock costs cash. Both live here.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Total capital in inventory" value={fmtInr(agg.totalCapital)} tone="brand" />
        <StatCard label="Capital \u2013 finished goods" value={fmtInr(agg.cashInFG)} tone="info" />
        <StatCard label="Capital \u2013 in transit" value={fmtInr(agg.cashInTransit)} tone="info" />
        <StatCard label="Capital \u2013 in production" value={fmtInr(agg.cashInProduction)} tone="info" />
        <StatCard label="Capital \u2013 dead stock" value={fmtInr(agg.cashInDead)} tone="critical" />
        <StatCard label="Capital \u2013 excess stock" value={fmtInr(agg.cashInExcess)} tone="attention" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Inventory ageing" subtitle="Units and \u20B9 value locked by age bucket \u2014 90+ days is where cash gets stuck">
          <AgeingChart skus={skus} />
        </SectionCard>
        <SectionCard title="Lost sales from stockouts" subtitle="Understock has a cost too, not just overstock">
          <LostSalesTable agg={agg} />
        </SectionCard>
      </div>

      <SectionCard title="Dead-stock action workflow" subtitle={`${deadWorkflow.length} SKUs \u00b7 ${fmtInr(agg.deadStockValue)} locked \u2014 route each one to an action`}>
        <DeadStockWorkflowTable deadWorkflow={deadWorkflow} />
      </SectionCard>
    </div>
  );
}

/* ============================================================================
   TAB 7 — FOUNDER VIEW / CONTROL ROOM  (signature dark panel)
   ========================================================================= */
function LedDot({ tone }) {
  const color = tone === "critical" ? "#f43f5e" : tone === "attention" ? "#f59e0b" : tone === "healthy" ? "#34d399" : "#38bdf8";
  return <span className="inline-block h-2 w-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />;
}

function FounderBigStat({ label, value, sub }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-indigo-300/70">{label}</div>
      <div className="mt-1 font-mono text-[28px] font-semibold leading-none text-white">{value}</div>
      {sub && <div className="mt-1.5 text-[12px] text-indigo-300/60">{sub}</div>}
    </div>
  );
}

function FounderTab({ skus, agg, pos, prod, campaigns }) {
  const worstStockout = agg.lostSalesSkus[0];
  const worstDead = [...skus].filter((s) => s.isDead).sort((a, b) => b.currentStock * b.landedCost - a.currentStock * a.landedCost)[0];
  const worstOverstock = [...agg.overstockSkus].sort((a, b) => (b.currentStock - b.velocity * 60) * b.landedCost - (a.currentStock - a.velocity * 60) * a.landedCost)[0];
  const worstProd = [...prod].sort((a, b) => a.deadlineDays - b.deadlineDays)[0];
  const worstPo = [...pos].filter((p) => p.status === "Delayed").sort((a, b) => b.daysDelayed - a.daysDelayed)[0];
  const riskyCampaign = campaigns.find((c) => c.readiness !== "Ready");

  const risks = [
    worstStockout && { text: `${worstStockout.product} \u00b7 ${worstStockout.color} ${worstStockout.size} \u2014 stockout risk, ${fmtInr(worstStockout.lostRevenue)} in sales at stake`, tone: "critical" },
    worstDead && { text: `${worstDead.product} \u00b7 ${worstDead.color} ${worstDead.size} \u2014 dead ${worstDead.lastSaleDaysAgo}d, ${fmtInr(worstDead.currentStock * worstDead.landedCost)} locked`, tone: "critical" },
    worstOverstock && { text: `${worstOverstock.product} \u00b7 ${worstOverstock.color} ${worstOverstock.size} \u2014 ${worstOverstock.daysOfCover}d of cover, capital tied up`, tone: "attention" },
    worstProd && { text: `${worstProd.id} (${worstProd.product}) \u2014 ${worstProd.status.toLowerCase()}, deadline ${worstProd.deadline}`, tone: worstProd.status === "Delayed" ? "critical" : "attention" },
    worstPo && { text: `${worstPo.poId} with ${worstPo.manufacturer.split(",")[0]} \u2014 ${worstPo.daysDelayed}d delayed on ${worstPo.product}`, tone: "critical" },
  ].filter(Boolean).slice(0, 5);

  const actions = [
    worstStockout && `Approve emergency reorder for ${worstStockout.sku} \u2014 lead time ${worstStockout.leadTime}d, stock runs out in ${Math.floor(worstStockout.daysOfCover)}d`,
    worstDead && `Decide fate of ${worstDead.product} (${worstDead.color}) \u2014 clearance, bundle, or write-off`,
    worstOverstock && `Pause replenishment on ${worstOverstock.product} (${worstOverstock.color} ${worstOverstock.size}) and plan a markdown`,
    worstProd && `Call ${worstProd.manufacturer.split(",")[0]} on ${worstProd.id} \u2014 currently stuck at ${worstProd.currentStage}`,
    riskyCampaign && `Review "${riskyCampaign.name}" before launch \u2014 readiness is ${riskyCampaign.readiness}`,
  ].filter(Boolean).slice(0, 5);

  const buyValue = skus.reduce((a, s) => { const r = classifyReplenishment(s); return a + (r.bucket === "BUY NOW" || r.bucket === "BUY SOON" ? r.purchaseValue : 0); }, 0);
  const holdValue = skus.reduce((a, s) => { const r = classifyReplenishment(s); return a + (r.bucket === "MONITOR" ? s.currentStock * s.landedCost : 0); }, 0);

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-slate-950 via-slate-950 to-indigo-950 p-6 text-white sm:p-8">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-indigo-300/70">
              <LedDot tone="healthy" /> Inventory control room \u00b7 {fmtDate(TODAY)}
            </div>
            <h2 className="mt-1.5 font-display text-2xl font-semibold">Today</h2>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
          <FounderBigStat label="Inventory value" value={inrCr(agg.inventoryValue)} sub={`${agg.totalUnits.toLocaleString("en-IN")} units`} />
          <FounderBigStat label="Weeks cover" value={agg.weeksOfSupply.toFixed(1) + "w"} />
          <FounderBigStat label="Sell-through" value={agg.sellThroughAgg.toFixed(0) + "%"} sub="trailing 30 days" />
          <FounderBigStat label="Dead stock" value={agg.deadStockPct.toFixed(0) + "%"} sub={fmtInr(agg.deadStockValue)} />
        </div>

        <div className="mt-7 grid gap-6 lg:grid-cols-2">
          <div>
            <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-rose-300/80">\uD83D\uDD34 Needs my attention</div>
            <div className="space-y-2">
              {risks.map((r, i) => (
                <div key={i} className="flex items-start gap-2.5 rounded-lg bg-white/5 px-3 py-2.5 text-[13px] text-slate-200">
                  <LedDot tone={r.tone} />
                  <span>{r.text}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-indigo-300/80">5 decisions I need to make today</div>
            <div className="space-y-2">
              {actions.map((a, i) => (
                <div key={i} className="flex items-start gap-2.5 rounded-lg bg-white/5 px-3 py-2.5 text-[13px] text-slate-200">
                  <span className="font-mono text-[11px] text-indigo-300/60">{i + 1}</span>
                  <span>{a}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-white/10 bg-white/5 px-3.5 py-3">
            <div className="text-[10.5px] uppercase tracking-wide text-indigo-300/60">Buy</div>
            <div className="mt-0.5 font-mono text-[17px] font-semibold text-white">{fmtInr(buyValue)}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-3.5 py-3">
            <div className="text-[10.5px] uppercase tracking-wide text-indigo-300/60">Hold</div>
            <div className="mt-0.5 font-mono text-[17px] font-semibold text-white">{fmtInr(holdValue)}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-3.5 py-3">
            <div className="text-[10.5px] uppercase tracking-wide text-indigo-300/60">Clear</div>
            <div className="mt-0.5 font-mono text-[17px] font-semibold text-white">{fmtInr(agg.deadStockValue)}</div>
          </div>
          <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3.5 py-3">
            <div className="text-[10.5px] uppercase tracking-wide text-rose-300/80">Cash at risk</div>
            <div className="mt-0.5 font-mono text-[17px] font-semibold text-rose-200">{fmtInr(agg.cashAtRisk)}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Stockouts at risk" value={fmtInr(agg.totalLostRevenue)} sub="potential lost sales" tone="critical" />
        <StatCard label="Excess inventory" value={fmtInr(agg.overstockValue)} tone="attention" />
        <StatCard label="Buying required" value={fmtInr(buyValue)} tone="info" />
        <StatCard label="Production delays" value={String(agg.delayedProd + agg.atRiskProd)} sub="orders flagged" tone="attention" />
      </div>
    </div>
  );
}

/* ============================================================================
   APP ROOT
   ========================================================================= */
const TABS = [
  { id: "home", label: "Command Center" },
  { id: "attention", label: "Needs Attention" },
  { id: "master", label: "Master Inventory" },
  { id: "buy", label: "Buying & Production" },
  { id: "forecast", label: "Forecast" },
  { id: "ageing", label: "Ageing & Cash" },
  { id: "founder", label: "Founder View" },
];

export default function OffcomfrtControlTower() {
  const [tab, setTab] = useState("home");

  const data = useMemo(() => {
    let skus = buildSkus();
    skus = applyAbc(skus);
    const pos = buildPurchaseOrders(skus);
    const prod = buildProductionOrders(skus);
    const rawMaterials = buildRawMaterials();
    const campaigns = buildCampaigns(skus);
    const suppliers = buildSupplierScorecard(pos);
    const agg = computeAggregates(skus, pos, prod);
    const matrix = buildAbcXyzMatrix(skus);
    const deadWorkflow = buildDeadStockWorkflow(skus);
    return { skus, pos, prod, rawMaterials, campaigns, suppliers, agg, matrix, deadWorkflow };
  }, []);

  return (
    <div className="ic-root min-h-screen bg-slate-50 text-slate-800">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .ic-root { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
        .ic-root .font-display { font-family: 'Space Grotesk', 'Inter', sans-serif; letter-spacing: -0.01em; }
        .ic-root .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        .ic-root ::selection { background: #c7d2fe; }
        .ic-root *:focus-visible { outline: 2px solid #4338ca; outline-offset: 1px; }
        .ic-tabscroll::-webkit-scrollbar { height: 0px; }
        @media (prefers-reduced-motion: reduce) { .ic-root * { transition: none !important; } }
      `}</style>

      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-950 font-display text-[13px] font-bold text-white">O</div>
            <div className="leading-tight">
              <div className="font-display text-[14.5px] font-semibold tracking-tight text-slate-900">OFFCOMFRT</div>
              <div className="text-[10.5px] uppercase tracking-[0.14em] text-slate-400">Inventory Control Tower</div>
            </div>
          </div>
          <div className="hidden text-right sm:block">
            <div className="text-[12px] text-slate-400">Live as of</div>
            <div className="font-mono text-[12.5px] font-medium text-slate-700">{fmtDate(TODAY)}</div>
          </div>
        </div>
        <nav className="ic-tabscroll mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-4 pb-2 sm:px-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                tab === t.id ? "bg-indigo-950 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        {tab === "home" && <CommandCenterTab skus={data.skus} agg={data.agg} pos={data.pos} prod={data.prod} />}
        {tab === "attention" && <NeedsAttentionTab skus={data.skus} agg={data.agg} prod={data.prod} />}
        {tab === "master" && <MasterInventoryTab skus={data.skus} />}
        {tab === "buy" && <ReplenishmentTab skus={data.skus} pos={data.pos} prod={data.prod} rawMaterials={data.rawMaterials} suppliers={data.suppliers} campaigns={data.campaigns} />}
        {tab === "forecast" && <ForecastTab skus={data.skus} matrix={data.matrix} />}
        {tab === "ageing" && <AgeingCashTab skus={data.skus} agg={data.agg} deadWorkflow={data.deadWorkflow} />}
        {tab === "founder" && <FounderTab skus={data.skus} agg={data.agg} pos={data.pos} prod={data.prod} campaigns={data.campaigns} />}
      </main>

      <footer className="mx-auto max-w-[1400px] px-4 pb-8 pt-2 text-center text-[11.5px] text-slate-400 sm:px-6">
        Sample data · illustrative dataset for Offcomfrt, generated for this v1 build — not connected to a live system.
      </footer>
    </div>
  );
}

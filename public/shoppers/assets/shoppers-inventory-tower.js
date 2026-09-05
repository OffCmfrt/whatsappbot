// ============================================================================
// OFFCOMFRT — INVENTORY CONTROL TOWER (Shoppers Hub edition)
// Vanilla-JS port of the control-tower prototype, wired to the live
// GET /api/admin/inventory endpoint. Structure mirrors the prototype 1:1:
//   Command Center · Needs Attention · Master Inventory · Buying & Production
//   Forecast · Ageing & Cash · Founder View
// Sections with no live data source (POs, production, raw materials,
// suppliers, campaigns) are generated as clearly-labelled SAMPLE data.
// Monetary values are at selling price — cost data is not available.
// ============================================================================
(function () {
    'use strict';

    /* ------------------------------ helpers ------------------------------ */
    const esc = (s) => (typeof window.escapeHtml === 'function')
        ? window.escapeHtml(s)
        : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const inr = (n) => '\u20B9' + Math.round(n || 0).toLocaleString('en-IN');
    const inrCr = (n) => '\u20B9' + ((n || 0) / 1e7).toFixed(2) + ' Cr';
    const inrL = (n) => '\u20B9' + ((n || 0) / 1e5).toFixed(1) + ' L';
    const fmtInr = (n) => (Math.abs(n || 0) >= 1e7 ? inrCr(n) : Math.abs(n || 0) >= 1e5 ? inrL(n) : inr(n));
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const num = (n) => Number(n || 0).toLocaleString('en-IN');

    // Seeded PRNG so sample sections are stable across renders (same seed as prototype)
    function mulberry32(seed) {
        let a = seed;
        return function () {
            a |= 0; a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const TONES = {
        critical: 'ict-tone-critical',
        attention: 'ict-tone-attention',
        healthy: 'ict-tone-healthy',
        info: 'ict-tone-info',
        neutral: 'ict-tone-neutral',
        brand: 'ict-tone-brand',
    };
    const pill = (tone, label) => `<span class="ict-pill ${TONES[tone] || TONES.neutral}"><span class="ict-pill-dot"></span>${esc(label)}</span>`;
    const SAMPLE_BADGE = '<span class="ict-sample-badge" title="Illustrative data — this system is not connected yet">SAMPLE</span>';
    const AT_PRICE_NOTE = 'at selling price · no cost data';

    const classificationTone = (bucket) => {
        if (bucket === 'BUY NOW') return 'critical';
        if (bucket === 'BUY SOON') return 'attention';
        if (bucket === 'MONITOR') return 'info';
        return 'neutral';
    };

    const statusTone = {
        'Dead': 'critical', 'Out of stock': 'critical', 'Stockout risk': 'critical',
        'Overstock': 'attention', 'Slow mover': 'attention', 'Healthy': 'healthy',
    };

    /* --------------------------- sample constants --------------------------- */
    const MANUFACTURERS = [
        { id: 'MFG-01', name: 'Sundari Knits, Tiruppur', leadTime: 24, reliability: 0.93 },
        { id: 'MFG-02', name: 'Vardaan Apparel, Ludhiana', leadTime: 32, reliability: 0.81 },
        { id: 'MFG-03', name: 'Falcon Garments, Noida', leadTime: 21, reliability: 0.9 },
        { id: 'MFG-04', name: 'Comfort Fab Exports, Bengaluru', leadTime: 28, reliability: 0.86 },
    ];
    const PROD_STAGES = ['Cutting', 'Stitching', 'Finishing', 'QC', 'Packing', 'Dispatched'];
    const PO_STATUS_TONE = { 'Open': 'info', 'Partially Received': 'attention', 'Fully Received': 'healthy', 'Delayed': 'critical', 'Cancelled': 'neutral' };
    const DEAD_STATUS_TONE = { Identified: 'info', Review: 'attention', 'Action Required': 'critical', Clearance: 'attention', Markdown: 'attention', 'Write-off': 'critical' };
    const ABCXYZ_STRATEGY = {
        AX: 'High value, predictable – replenish aggressively, tightest reorder discipline.',
        AY: 'High value, some swings – keep close watch, moderate safety stock.',
        AZ: 'High value, unpredictable – forecast carefully, protect with safety stock.',
        BX: 'Steady mid-tier – standard replenishment cadence.',
        BY: 'Mid-tier, variable – review monthly, adjust safety stock.',
        BZ: 'Mid-tier, erratic – buy conservatively, expect surprises.',
        CX: 'Low value, predictable – simple, infrequent reordering.',
        CY: 'Low value, some variability – light-touch monitoring only.',
        CZ: 'Low value, unpredictable – avoid tying up capital here.',
    };
    const AGE_BUCKETS = ['0-30', '31-60', '61-90', '91-120', '121-180', '180+'];
    const SCENARIOS = {
        Base: { mult: 1, label: 'Base case' },
        Upside: { mult: 1.25, label: 'Upside' },
        Downside: { mult: 0.78, label: 'Downside' },
        Campaign: { mult: 1.3, label: 'Campaign (+30%)' },
    };

    /* --------------------------------- state -------------------------------- */
    const ICT = {
        data: null,          // raw API payload
        skus: [],            // flat SKU records
        agg: null,           // portfolio aggregates
        sample: null,        // { pos, prod, rawMaterials, suppliers, campaigns }
        movements: null,     // date-wise movement data
        movementsLoading: false,
        tab: 'home',
        windowDays: 90,
        loading: false,
        ui: {
            attention: 'stockout',
            rep: 'buy',
            repFilter: 'BUY NOW',
            poFilter: 'All',
            master: { q: '', product: 'All', status: 'All', abc: 'All', page: 0, expanded: null, dateFrom: '', dateTo: '', showMovements: false },
            forecast: { productId: '__all', horizon: 30, scenario: 'Base' },
            size: { productId: null },
            feQty: 1000,
            sort: {},        // tableId -> { key, dir }
        },
    };

    /* --------------------------- data mapping (live) --------------------------- */
    function mapSkus(data) {
        const skus = [];
        let seq = 1;
        const mfgFor = (productId) => {
            const digits = String(productId).replace(/\D/g, '');
            const n = digits ? parseInt(digits.slice(-6), 10) : 0;
            return MANUFACTURERS[n % MANUFACTURERS.length];
        };
        for (const p of (data.products || [])) {
            const mfg = mfgFor(p.id);
            for (const v of (p.variants || [])) {
                const parts = String(v.title || '').split('/').map((x) => x.trim()).filter(Boolean);
                const color = parts[0] || 'Default';
                const size = parts.slice(1).join(' / ') || '';
                const cover = v.days_of_cover;
                const stockoutEta = (v.velocity > 0.05 && cover !== 999)
                    ? new Date(Date.now() + Math.floor(cover) * 86400000) : null;
                skus.push({
                    seq: seq++,
                    sku: v.sku_code || v.sku || `#${v.id}`,
                    productId: String(p.id),
                    product: p.title,
                    productImage: p.image,
                    color, size,
                    manufacturer: mfg.name,             // SAMPLE anchor (no live source)
                    manufacturerId: mfg.id,
                    price: v.price,
                    landedCost: v.price,                // no cost data — at selling price
                    currentStock: v.on_hand,
                    reserved: v.in_circulation,         // committed, not yet delivered
                    rtoIncoming: v.rto_incoming,
                    returnIncoming: v.return_incoming,
                    exchangeIncoming: v.exchange_incoming,
                    exchangeOutgoing: v.exchange_outgoing,
                    finalAvailable: v.final_available,
                    inTransit: v.in_circulation,
                    incomingQty: v.incoming_qty,
                    incomingEtaDays: v.incoming_eta_days,
                    velocity: v.velocity,
                    sales7: v.sales7, sales14: v.sales14, sales30: v.sales30, sales60: v.sales60, sales90: v.sales90,
                    sellThrough30: v.sell_through_30,
                    receivedUnits: v.on_hand + v.sales30,
                    daysOfCover: cover,
                    weeksOfSupply: v.weeks_of_supply,
                    leadTime: v.lead_time_days,
                    safetyStock: v.safety_stock,
                    reorderPoint: v.reorder_point,
                    xyz: v.xyz, cv: v.cv, abc: v.abc || 'C',
                    lastSaleDaysAgo: v.last_sale_days_ago,
                    lastSaleDate: v.last_sale_days_ago != null ? (v.last_sale_days_ago <= 84 ? fmtDate(Date.now() - v.last_sale_days_ago * 86400000) : '>84d ago') : 'Never sold',
                    stockoutEta,
                    isStockoutRisk: v.is_stockout_risk,
                    isOverstock: v.is_overstock,
                    isDead: v.is_dead,
                    isSlowMover: v.is_slow_mover,
                    ageingDays: v.ageing_days,
                    ageBucket: v.age_bucket,
                    weeklySales: v.weekly_sales,
                    status: v.status,
                    rep: v.replenishment,
                    rtoRatePct: v.rto_rate_pct,
                    returnRatePct: v.return_rate_pct,
                    delivered: v.delivered,
                    lowStock: v.low_stock,
                });
            }
        }
        return skus;
    }

    /* --------------------- aggregates (mirrors prototype) --------------------- */
    function computeAggregates(skus, pos, prod) {
        const sum = (fn) => skus.reduce((a, s) => a + fn(s), 0);
        const totalUnits = sum((s) => s.currentStock);
        const inventoryValue = sum((s) => s.currentStock * s.landedCost);
        const sellableValue = sum((s) => Math.max(0, s.finalAvailable) * s.landedCost);
        const reservedUnits = sum((s) => s.reserved);
        const inTransitUnits = sum((s) => s.inTransit);
        const rtoUnits = sum((s) => s.rtoIncoming);
        const returnUnits = sum((s) => s.returnIncoming);
        const exchangeInUnits = sum((s) => s.exchangeIncoming);
        const exchangeOutUnits = sum((s) => s.exchangeOutgoing);

        const sales30Total = sum((s) => s.sales30);
        const sales7Total = sum((s) => s.sales7);
        const annualRevenue = sum((s) => s.sales30 * 12 * s.price);
        // No cost data — COGS proxied at selling price, so turnover/days are
        // demand-based and labelled as such in the UI.
        const daysOfInventory = annualRevenue > 0 ? (inventoryValue / annualRevenue) * 365 : 0;
        const turnover = daysOfInventory > 0 ? 365 / daysOfInventory : 0;
        const avgDailyUnits = sum((s) => s.velocity);
        const weeksOfSupply = avgDailyUnits > 0 ? totalUnits / avgDailyUnits / 7 : 0;
        const receivedTotal = sum((s) => s.receivedUnits) || 1;
        const sellThroughAgg = sales30Total / receivedTotal * 100;

        const stockoutSkuCount = skus.filter((s) => s.currentStock === 0 && s.velocity > 0.05).length;
        const stockoutRate = skus.length ? (stockoutSkuCount / skus.length) * 100 : 0;

        const deadStockSkus = skus.filter((s) => s.isDead);
        const deadStockValue = deadStockSkus.reduce((a, s) => a + s.currentStock * s.landedCost, 0);
        const deadStockPct = deadStockValue / (inventoryValue || 1) * 100;

        const ageingValue90plus = skus.filter((s) => s.ageingDays != null && s.ageingDays > 90)
            .reduce((a, s) => a + s.currentStock * s.landedCost, 0);
        const ageingPct = ageingValue90plus / (inventoryValue || 1) * 100;

        const overstockSkus = skus.filter((s) => s.isOverstock);
        const overstockValue = overstockSkus.reduce((a, s) => {
            const excess = Math.max(0, s.currentStock - s.velocity * 60);
            return a + excess * s.landedCost;
        }, 0);

        const stockoutRiskSkus = skus.filter((s) => s.isStockoutRisk);
        const lostSalesSkus = stockoutRiskSkus.map((s) => {
            const daysOut = Math.max(0, s.leadTime - s.daysOfCover);
            const lostUnits = Math.round(daysOut * s.velocity);
            return { ...s, lostUnits, lostRevenue: lostUnits * s.price };
        }).sort((a, b) => b.lostRevenue - a.lostRevenue);
        const totalLostRevenue = lostSalesSkus.reduce((a, s) => a + s.lostRevenue, 0);

        const delayedPOs = pos.filter((p) => p.status === 'Delayed').length;
        const delayedProd = prod.filter((p) => p.status === 'Delayed').length;
        const atRiskProd = prod.filter((p) => p.status === 'At Risk').length;

        const cashInFG = inventoryValue;
        const cashInDead = deadStockValue;
        const cashInExcess = overstockValue;
        const cashAtRisk = cashInDead + cashInExcess;
        const invValuePctSales = annualRevenue > 0 ? inventoryValue / annualRevenue * 100 : 0;

        const shippedUnits = sum((s) => s.delivered + s.rtoIncoming + s.inTransit);
        const rtoRateAgg = shippedUnits > 0 ? rtoUnits / shippedUnits * 100 : 0;

        return {
            totalUnits, inventoryValue, sellableValue, reservedUnits, inTransitUnits, rtoUnits, returnUnits,
            exchangeInUnits, exchangeOutUnits, sales30Total, sales7Total, annualRevenue,
            daysOfInventory, turnover, weeksOfSupply, sellThroughAgg, stockoutRate, stockoutSkuCount,
            deadStockValue, deadStockPct, ageingPct, ageingValue90plus, overstockValue, overstockSkus,
            stockoutRiskSkus, lostSalesSkus, totalLostRevenue, delayedPOs, delayedProd, atRiskProd,
            cashInFG, cashInDead, cashInExcess, cashAtRisk, invValuePctSales, rtoRateAgg,
        };
    }

    /* ------------------- sample builders (labelled in UI) ------------------- */
    function buildSampleData(skus) {
        const rand = mulberry32(20260829);
        const ri = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
        const rf = (min, max) => rand() * (max - min) + min;
        const pick = (arr) => arr[Math.floor(rand() * arr.length)];
        const products = [...new Map(skus.map((s) => [s.productId, s])).values()];
        const pickProduct = () => products.length ? pick(products) : null;

        // Purchase orders
        const statuses = ['Open', 'Partially Received', 'Fully Received', 'Delayed', 'Cancelled'];
        const weights = [0.28, 0.2, 0.28, 0.18, 0.06];
        const pos = [];
        for (let i = 0; i < 16; i++) {
            const sample = pickProduct();
            if (!sample) break;
            let r = rand(), acc = 0, status = statuses[0];
            for (let j = 0; j < statuses.length; j++) { acc += weights[j]; if (r <= acc) { status = statuses[j]; break; } }
            const orderQty = ri(150, 900);
            const orderDate = new Date(Date.now() - ri(5, 60) * 86400000);
            const expectedDate = new Date(orderDate.getTime() + sample.leadTime * 86400000);
            let receivedQty = 0, actualDate = null, daysDelayed = 0;
            if (status === 'Fully Received') { receivedQty = orderQty; actualDate = new Date(expectedDate.getTime() + ri(-3, 2) * 86400000); daysDelayed = Math.max(0, Math.round((actualDate - expectedDate) / 86400000)); }
            else if (status === 'Partially Received') { receivedQty = Math.round(orderQty * rf(0.3, 0.75)); }
            else if (status === 'Delayed') { daysDelayed = ri(4, 22); }
            pos.push({
                poId: `PO-${1000 + i}`, product: sample.product, productId: sample.productId,
                manufacturer: sample.manufacturer, manufacturerId: sample.manufacturerId,
                orderQty, receivedQty, balance: orderQty - receivedQty, status,
                orderDate: fmtDate(orderDate), expectedDate: fmtDate(expectedDate),
                actualDate: actualDate ? fmtDate(actualDate) : '–', daysDelayed, leadTime: sample.leadTime,
            });
        }

        // Production orders
        const prodOrders = [];
        for (let i = 0; i < 10; i++) {
            const sample = pickProduct();
            if (!sample) break;
            const planned = ri(400, 1400);
            const stageIdx = ri(0, PROD_STAGES.length - 1);
            const progressPct = clamp((stageIdx + 1) / PROD_STAGES.length + rf(-0.08, 0.08), 0.08, 1);
            const finished = Math.round(planned * clamp(progressPct, 0, 1));
            const qcPassed = Math.round(finished * rf(0.9, 0.98));
            const packed = stageIdx >= 4 ? Math.round(qcPassed * rf(0.85, 1)) : 0;
            const dispatched = stageIdx >= 5 ? packed : 0;
            const deadlineDays = ri(-6, 30);
            const status = deadlineDays < 0 ? 'Delayed' : deadlineDays < 6 ? 'At Risk' : 'On Track';
            prodOrders.push({
                id: `PRD-${300 + i}`, product: sample.product, productId: sample.productId,
                manufacturer: sample.manufacturer, planned, finished, qcPassed, packed, dispatched,
                currentStage: PROD_STAGES[stageIdx], status,
                productionStart: fmtDate(Date.now() - ri(10, 45) * 86400000),
                deadline: fmtDate(Date.now() + deadlineDays * 86400000),
                deadlineDays,
            });
        }

        // Raw materials
        const rmDefs = [
            { name: 'Cotton Single Jersey Fabric (Black)', unit: 'kg', cost: 385 },
            { name: 'Cotton Single Jersey Fabric (White)', unit: 'kg', cost: 370 },
            { name: 'Rib Fabric – Collar/Cuff', unit: 'kg', cost: 410 },
            { name: 'Woven Main Label', unit: 'pcs', cost: 3.2 },
            { name: 'Care Label', unit: 'pcs', cost: 1.1 },
            { name: 'Polybag – Branded', unit: 'pcs', cost: 2.4 },
            { name: 'Carton – Export Grade', unit: 'pcs', cost: 28 },
            { name: 'Sewing Thread – Cone', unit: 'cone', cost: 65 },
        ];
        const rawMaterials = rmDefs.map((it, i) => {
            const opening = ri(400, 3200), inward = ri(200, 1500), consumption = ri(300, 1600);
            const wastage = Math.round(consumption * rf(0.01, 0.04));
            const closing = Math.max(0, opening + inward - consumption - wastage);
            const minStock = Math.round(consumption * rf(0.6, 1));
            return { id: `RM-${i + 1}`, ...it, opening, inward, consumption, wastage, closing, minStock, supplier: pick(MANUFACTURERS).name, leadTime: ri(7, 21), belowMin: closing < minStock };
        });

        // Supplier scorecard
        const suppliers = MANUFACTURERS.map((m) => {
            const mine = pos.filter((p) => p.manufacturerId === m.id);
            const ordered = mine.reduce((a, p) => a + p.orderQty, 0);
            const received = mine.reduce((a, p) => a + p.receivedQty, 0);
            const onTimePct = Math.round(m.reliability * 100);
            const tone = m.reliability >= 0.9 ? 'healthy' : m.reliability >= 0.83 ? 'attention' : 'critical';
            return {
                id: m.id, name: m.name, orders: mine.length || ri(3, 9), ordered, received,
                onTimePct, rejectionPct: +rf(0.5, 5.5).toFixed(1), shortagePct: +rf(0, 3.5).toFixed(1),
                avgLeadTime: m.leadTime, leadTimeVariance: ri(2, 8), costVariancePct: +rf(-4, 7).toFixed(1), tone,
            };
        });

        // Campaign readiness — anchored to the 3 strongest real products
        const topProducts = [...new Map(skus.map((s) => [s.productId, s])).values()]
            .sort((a, b) => b.sales30 - a.sales30).slice(0, 3);
        const campDefs = [
            { name: 'Diwali Sale – Site-wide', upliftPct: 45, startInDays: 12, durationDays: 10 },
            { name: 'Meta Prospecting – Hero SKU', upliftPct: 30, startInDays: 5, durationDays: 21 },
            { name: 'Influencer Drop – New Arrival', upliftPct: 60, startInDays: 3, durationDays: 14 },
        ];
        const campaigns = campDefs.map((c, i) => {
            const anchor = topProducts[i % Math.max(1, topProducts.length)];
            const relevant = anchor ? skus.filter((s) => s.productId === anchor.productId) : [];
            const stock = relevant.reduce((a, s) => a + s.currentStock, 0);
            const incoming = relevant.reduce((a, s) => a + s.incomingQty, 0);
            const dailyVel = relevant.reduce((a, s) => a + s.velocity, 0);
            const forecastUnits = Math.round(dailyVel * (1 + c.upliftPct / 100) * c.durationDays);
            const available = stock + (c.startInDays < 20 ? incoming : 0);
            const readiness = available >= forecastUnits ? 'Ready' : available >= forecastUnits * 0.6 ? 'Risk' : 'Not Ready';
            return { ...c, product: anchor ? anchor.product : 'Catalog', stock, incoming, forecastUnits, available, readiness, startDate: fmtDate(Date.now() + c.startInDays * 86400000) };
        });

        return { pos, prod: prodOrders, rawMaterials, suppliers, campaigns };
    }

    const DEAD_STATUSES = ['Identified', 'Review', 'Action Required', 'Clearance', 'Markdown', 'Write-off'];
    function buildDeadWorkflow(skus) {
        const rand = mulberry32(777);
        return skus.filter((s) => s.isDead).map((s) => ({
            ...s,
            workflowStatus: DEAD_STATUSES[Math.floor(rand() * DEAD_STATUSES.length)],
            recoveryPct: 20 + Math.floor(rand() * 46),
        }));
    }


    /* ------------------------------ SVG charts ------------------------------ */
    // Dependency-free inline SVG. Fixed viewBox, scales to container width.
    function lineChartSvg(series, { height = 260, refLabel = 'W0' } = {}) {
        const W = 860, H = height, padL = 42, padR = 14, padT = 14, padB = 26;
        const maxV = Math.max(1, ...series.map((p) => Math.max(p.actual || 0, p.forecast || 0)));
        const x = (i) => padL + (i / Math.max(1, series.length - 1)) * (W - padL - padR);
        const y = (v) => padT + (1 - v / maxV) * (H - padT - padB);
        const path = (key) => {
            let d = '', pen = false;
            series.forEach((p, i) => {
                const v = p[key];
                if (v == null) { pen = false; return; }
                d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
                pen = true;
            });
            return d.trim();
        };
        const grid = [0.25, 0.5, 0.75, 1].map((f) => {
            const gy = padT + f * (H - padT - padB);
            return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(255,255,255,0.07)" stroke-dasharray="3 4"/>`
                + `<text x="${padL - 6}" y="${gy + 3}" text-anchor="end" font-size="9" fill="rgba(255,255,255,0.4)">${Math.round(maxV * (1 - f))}</text>`;
        }).join('');
        const refIdx = series.findIndex((p) => p.label === refLabel);
        const refLine = refIdx >= 0
            ? `<line x1="${x(refIdx)}" y1="${padT}" x2="${x(refIdx)}" y2="${H - padB}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="4 4"/>
               <text x="${x(refIdx) + 4}" y="${padT + 9}" font-size="9" fill="rgba(255,255,255,0.45)">Today</text>` : '';
        const labels = series.map((p, i) => (i % Math.ceil(series.length / 12) === 0 || i === series.length - 1)
            ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.4)">${esc(p.label)}</text>` : '').join('');
        const dots = (key, color) => series.map((p, i) => p[key] == null ? '' :
            `<circle cx="${x(i)}" cy="${y(p[key])}" r="2.6" fill="${color}"><title>${esc(p.label)} · ${num(p[key])} units</title></circle>`).join('');
        return `<svg class="ict-chart" viewBox="0 0 ${W} ${H}" role="img">
            ${grid}${refLine}
            <path d="${path('actual')}" fill="none" stroke="#fff" stroke-width="2"/>
            <path d="${path('forecast')}" fill="none" stroke="#8b8bff" stroke-width="2" stroke-dasharray="6 4"/>
            ${dots('actual', '#fff')}${dots('forecast', '#8b8bff')}
            ${labels}
        </svg>`;
    }

    function groupedBarsSvg(groups, { height = 240, unit = '%' } = {}) {
        // groups: [{ label, bars: [{ value, cls, name }] }]
        const W = 860, H = height, padL = 40, padR = 12, padT = 14, padB = 26;
        const maxV = Math.max(1, ...groups.flatMap((g) => g.bars.map((b) => b.value)));
        const gw = (W - padL - padR) / Math.max(1, groups.length);
        const bars = groups.map((g, gi) => {
            const bw = Math.min(30, (gw * 0.6) / g.bars.length);
            const x0 = padL + gi * gw + (gw - bw * g.bars.length - 6 * (g.bars.length - 1)) / 2;
            return g.bars.map((b, bi) => {
                const bh = (b.value / maxV) * (H - padT - padB);
                const bx = x0 + bi * (bw + 6);
                const by = H - padB - bh;
                return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}" rx="3" class="${b.cls}">
                    <title>${esc(g.label)} · ${esc(b.name)}: ${num(b.value)}${unit}</title></rect>`;
            }).join('') + `<text x="${padL + gi * gw + gw / 2}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="rgba(255,255,255,0.45)">${esc(g.label)}</text>`;
        }).join('');
        const grid = [0.5, 1].map((f) => {
            const gy = padT + f * (H - padT - padB);
            return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(255,255,255,0.07)" stroke-dasharray="3 4"/>`
                + `<text x="${padL - 6}" y="${gy + 3}" text-anchor="end" font-size="9" fill="rgba(255,255,255,0.4)">${Math.round(maxV * (1 - f))}</text>`;
        }).join('');
        return `<svg class="ict-chart" viewBox="0 0 ${W} ${H}" role="img">${grid}${bars}</svg>`;
    }

    /* --------------------------- shared UI builders --------------------------- */
    const sectionCard = (title, subtitle, body, opts = {}) => `
        <section class="ict-card ${opts.cls || ''}">
            ${(title || opts.action) ? `
            <header class="ict-card-head">
                <div>
                    ${title ? `<h3>${title} ${opts.sample ? SAMPLE_BADGE : ''}</h3>` : ''}
                    ${subtitle ? `<p>${subtitle}</p>` : ''}
                </div>
                ${opts.action || ''}
            </header>` : ''}
            <div class="ict-card-body">${body}</div>
        </section>`;

    const statCard = (label, value, sub, tone = 'neutral') => `
        <div class="ict-stat ${TONES[tone] || ''}">
            <div class="ict-stat-label">${label}</div>
            <div class="ict-stat-value">${value}</div>
            ${sub ? `<div class="ict-stat-sub">${sub}</div>` : ''}
        </div>`;

    const healthTile = (label, value, formula) => `
        <div class="ict-health">
            <div class="ict-health-label">${label}</div>
            <div class="ict-health-value">${value}<span class="ict-health-trend">–</span></div>
            <div class="ict-health-tip">${esc(formula)}</div>
        </div>`;

    const th = (tableId, label, key, align = 'left') => {
        const st = ICT.ui.sort[tableId] || {};
        const active = st.key === key;
        return `<th class="ict-th ict-align-${align} ${active ? 'active' : ''}" data-ict="sort" data-table="${tableId}" data-key="${key}">
            ${label}${active ? `<span class="ict-sort-arrow ${st.dir === 'asc' ? 'asc' : ''}">▾</span>` : ''}
        </th>`;
    };
    const plainTh = (label, align = 'left') => `<th class="ict-th ict-th-static ict-align-${align}">${label}</th>`;

    function sortedRows(tableId, rows, initialKey, initialDir = 'desc') {
        if (!ICT.ui.sort[tableId]) ICT.ui.sort[tableId] = { key: initialKey, dir: initialDir };
        const { key, dir } = ICT.ui.sort[tableId];
        const copy = [...rows];
        copy.sort((a, b) => {
            let av = a[key], bv = b[key];
            if (av == null) av = dir === 'asc' ? Infinity : -Infinity;
            if (bv == null) bv = dir === 'asc' ? Infinity : -Infinity;
            if (typeof av === 'string') { av = av.toLowerCase(); bv = String(bv || '').toLowerCase(); }
            if (av < bv) return dir === 'asc' ? -1 : 1;
            if (av > bv) return dir === 'asc' ? 1 : -1;
            return 0;
        });
        return copy;
    }

    const chip = (active, label, attrs = '') =>
        `<button class="ict-chip ${active ? 'active' : ''}" data-ict="chip" ${attrs}>${label}</button>`;

    const emptyState = (text) => `<div class="ict-empty">${text}</div>`;

    function paginationHtml(tableId, page, total, pageSize) {
        const pages = Math.max(1, Math.ceil(total / pageSize));
        if (pages <= 1) return '';
        return `<div class="ict-pagination">
            <span>Page ${page + 1} of ${pages} · ${num(total)} rows</span>
            <span class="ict-page-btns">
                <button class="ict-btn-ghost" data-ict="page" data-table="${tableId}" data-dir="-1" ${page === 0 ? 'disabled' : ''}>Prev</button>
                <button class="ict-btn-ghost" data-ict="page" data-table="${tableId}" data-dir="1" ${page >= pages - 1 ? 'disabled' : ''}>Next</button>
            </span>
        </div>`;
    }

    /* ============================ TAB 1 — COMMAND CENTER ============================ */
    function renderCommandCenter() {
        const { agg, skus, sample } = ICT;
        const counts = ICT.data.summary.counts;
        const fc = ICT.data.summary.forecast;

        const stats = [
            statCard('Total inventory units', num(agg.totalUnits), 'On hand across catalog', 'brand'),
            statCard('Inventory value', fmtInr(agg.inventoryValue), AT_PRICE_NOTE, 'brand'),
            statCard('Final sellable stock', num(ICT.data.summary.final_available_units), 'on hand + pipeline inbound − exchange outbound', 'healthy'),
            statCard('In circulation', num(agg.reservedUnits), 'shipped to customers, en route', 'info'),
            statCard('RTO incoming', num(agg.rtoUnits), 'returning to warehouse', counts.stockout_risk > 0 ? 'attention' : 'neutral'),
            statCard('Returns incoming', num(agg.returnUnits), 'open customer returns', 'info'),
            statCard('Exchange pipeline', `${num(agg.exchangeInUnits)} / ${num(agg.exchangeOutUnits)}`, 'inbound / outbound units', 'neutral'),
            statCard('Low stock variants', num(ICT.data.summary.low_stock_variants), '≤ 3 units on hand', ICT.data.summary.low_stock_variants > 0 ? 'critical' : 'healthy'),
        ].join('');

        const health = [
            healthTile('Days of inventory', agg.daysOfInventory.toFixed(0) + 'd', 'Inventory value ÷ annualized sales value × 365 (demand basis, at price)'),
            healthTile('Weeks of supply', agg.weeksOfSupply.toFixed(1) + 'w', 'Total units ÷ average daily velocity ÷ 7'),
            healthTile('Inventory turnover', agg.turnover.toFixed(1) + 'x', 'Annualized sales value ÷ inventory value'),
            healthTile('Sell-through (30d)', agg.sellThroughAgg.toFixed(1) + '%', 'Units sold 30d ÷ (units sold + stock on hand)'),
            healthTile('Stockout rate', agg.stockoutRate.toFixed(1) + '%', 'SKUs at zero stock with demand ÷ total SKUs'),
            healthTile('Dead stock %', agg.deadStockPct.toFixed(1) + '%', `No sale in 45d+ · ${fmtInr(agg.deadStockValue)} locked`),
            healthTile('Ageing inventory %', agg.ageingPct.toFixed(1) + '%', 'Value of products live 90d+ ÷ total value (launch-date proxy)'),
            healthTile('Low stock variants', num(ICT.data.summary.low_stock_variants), 'Variants with ≤ 3 units on hand'),
            healthTile('Forecast accuracy', fc.accuracy_pct.toFixed(0) + '%', `100 − WMAPE (${fc.wmape_pct}%), weighted off last 5 weeks`),
            healthTile('RTO rate', agg.rtoRateAgg.toFixed(1) + '%', 'RTO units ÷ shipped units (trailing window)'),
            healthTile('Inv. value % of sales', agg.invValuePctSales.toFixed(1) + '%', 'Inventory value ÷ annualized revenue'),
            healthTile('Run-rate revenue', inrCr(agg.annualRevenue), '30-day sales × 12, at selling price'),
        ].join('');

        const attention = `
            <div class="ict-attention-grid">
                <div class="ict-attention-box critical">
                    <div class="ict-attention-label">Stockout risk</div>
                    <div class="ict-attention-value">${counts.stockout_risk} SKUs</div>
                    <div class="ict-attention-sub">${fmtInr(agg.totalLostRevenue)} sales at risk</div>
                </div>
                <div class="ict-attention-box attention">
                    <div class="ict-attention-label">Overstock</div>
                    <div class="ict-attention-value">${counts.overstock} SKUs</div>
                    <div class="ict-attention-sub">${fmtInr(agg.overstockValue)} excess</div>
                </div>
                <div class="ict-attention-box critical">
                    <div class="ict-attention-label">Dead stock</div>
                    <div class="ict-attention-value">${counts.dead} SKUs</div>
                    <div class="ict-attention-sub">${fmtInr(agg.deadStockValue)} locked</div>
                </div>
                <div class="ict-attention-box info">
                    <div class="ict-attention-label">Production delays ${SAMPLE_BADGE}</div>
                    <div class="ict-attention-value">${agg.delayedProd + agg.atRiskProd} orders</div>
                    <div class="ict-attention-sub">${agg.delayedProd} delayed · ${agg.atRiskProd} at risk</div>
                </div>
            </div>`;

        const stages = [
            { name: 'On hand (sellable)', units: ICT.data.summary.on_hand_units, cls: 'bar-brand' },
            { name: 'In circulation', units: agg.inTransitUnits, cls: 'bar-info' },
            { name: 'RTO incoming', units: agg.rtoUnits, cls: 'bar-attention' },
            { name: 'Returns incoming', units: agg.returnUnits, cls: 'bar-info' },
            { name: 'Exchange incoming', units: agg.exchangeInUnits, cls: 'bar-info' },
            { name: 'Exchange outgoing (reserved)', units: agg.exchangeOutUnits, cls: 'bar-critical' },
        ];
        const maxStage = Math.max(1, ...stages.map((s) => s.units));
        const byStage = stages.map((s) => `
            <div class="ict-stage">
                <div class="ict-stage-head"><span>${s.name}</span><span class="ict-stage-units">${num(s.units)}</span></div>
                <div class="ict-stage-track"><div class="ict-stage-fill ${s.cls}" style="width:${(s.units / maxStage * 100).toFixed(1)}%"></div></div>
            </div>`).join('');

        return `
            <div class="ict-page-head">
                <h2>Inventory at a glance</h2>
                <p>Every SKU, every pipeline stage · velocity over trailing 84 days · as of ${fmtDate(new Date())}</p>
            </div>
            <div class="ict-stats-grid">${stats}</div>
            ${sectionCard('Key health metrics', 'Hover a tile for the formula · derived from live orders & catalog', `<div class="ict-health-grid">${health}</div>`)}
            <div class="ict-grid-2-1">
                ${sectionCard('Needs your attention today', 'Full detail on the Needs Attention tab', attention)}
                ${sectionCard('Inventory by pipeline stage', 'Live units by state', byStage)}
            </div>`;
    }

    /* ============================ TAB 2 — NEEDS ATTENTION ============================ */
    function stockoutTable() {
        const rows = ICT.skus.filter((s) => s.isStockoutRisk)
            .map((s) => ({ ...s, daysRemaining: Math.max(0, Math.floor(s.daysOfCover)) }));
        if (!rows.length) return emptyState('No SKUs are at stockout risk right now.');
        const sorted = sortedRows('stockout', rows, 'daysRemaining', 'asc');
        return `<div class="ict-table-wrap"><table class="ict-table">
            <thead><tr>
                ${th('stockout', 'SKU', 'sku')}${th('stockout', 'Product / Variant', 'product')}
                ${th('stockout', 'Stock', 'currentStock', 'right')}${th('stockout', 'Velocity/d', 'velocity', 'right')}
                ${th('stockout', 'Days left', 'daysRemaining', 'right')}${th('stockout', 'Incoming', 'incomingQty', 'right')}
                ${th('stockout', 'ETA', 'incomingEtaDays')}${th('stockout', 'Stockout date', 'stockoutEta')}
                ${plainTh('Recommended action')}
            </tr></thead>
            <tbody>${sorted.map((s) => `<tr>
                <td class="ict-mono ict-muted">${esc(s.sku)}</td>
                <td>${esc(s.product)} <span class="ict-dim">· ${esc(s.color)}${s.size ? ' · ' + esc(s.size) : ''}</span></td>
                <td class="ict-num">${num(s.currentStock)}</td>
                <td class="ict-num">${s.velocity.toFixed(1)}</td>
                <td class="ict-num">${pill(s.daysRemaining <= 7 ? 'critical' : 'attention', s.daysRemaining + 'd')}</td>
                <td class="ict-num">${s.incomingQty || '–'}</td>
                <td class="ict-muted">${s.incomingEtaDays ? s.incomingEtaDays + 'd' : '–'}</td>
                <td class="ict-muted">${s.stockoutEta ? fmtDate(s.stockoutEta) : '–'}</td>
                <td class="ict-muted">Reorder ${num(s.reorderPoint)}u+ · lead time ${s.leadTime}d (assumed)</td>
            </tr>`).join('')}</tbody></table></div>`;
    }

    function overstockTable() {
        const rows = ICT.skus.filter((s) => s.isOverstock).map((s) => {
            const expectedDemand60 = Math.round(s.velocity * 60);
            const excessUnits = Math.max(0, s.currentStock - expectedDemand60);
            return { ...s, expectedDemand60, excessUnits, excessValue: excessUnits * s.landedCost };
        });
        if (!rows.length) return emptyState('No SKUs are meaningfully overstocked.');
        const sorted = sortedRows('overstock', rows, 'excessValue', 'desc').slice(0, 30);
        return `<div class="ict-table-wrap"><table class="ict-table">
            <thead><tr>
                ${th('overstock', 'SKU', 'sku')}${th('overstock', 'Product / Variant', 'product')}
                ${th('overstock', 'Current units', 'currentStock', 'right')}${th('overstock', 'Expected demand (60d)', 'expectedDemand60', 'right')}
                ${th('overstock', 'Excess units', 'excessUnits', 'right')}${th('overstock', 'Excess value', 'excessValue', 'right')}
                ${th('overstock', 'Days of cover', 'daysOfCover', 'right')}${plainTh('Recommended action')}
            </tr></thead>
            <tbody>${sorted.map((s) => `<tr>
                <td class="ict-mono ict-muted">${esc(s.sku)}</td>
                <td>${esc(s.product)} <span class="ict-dim">· ${esc(s.color)}${s.size ? ' · ' + esc(s.size) : ''}</span></td>
                <td class="ict-num">${num(s.currentStock)}</td>
                <td class="ict-num">${num(s.expectedDemand60)}</td>
                <td class="ict-num">${num(s.excessUnits)}</td>
                <td class="ict-num ict-attention-text">${fmtInr(s.excessValue)}</td>
                <td class="ict-num">${s.daysOfCover}d</td>
                <td class="ict-muted">Pause replenishment · consider bundle or markdown</td>
            </tr>`).join('')}</tbody></table></div>`;
    }

    function deadTable() {
        const rows = ICT.skus.filter((s) => s.isDead).map((s) => ({ ...s, value: s.currentStock * s.landedCost }));
        if (!rows.length) return emptyState('No dead stock detected.');
        const sorted = sortedRows('dead', rows, 'value', 'desc');
        return `<div class="ict-table-wrap"><table class="ict-table">
            <thead><tr>
                ${th('dead', 'SKU', 'sku')}${th('dead', 'Product / Variant', 'product')}
                ${th('dead', 'Units', 'currentStock', 'right')}${th('dead', 'Value', 'value', 'right')}
                ${th('dead', 'Last sale', 'lastSaleDaysAgo', 'right')}${th('dead', 'Age bucket', 'ageBucket')}
                ${plainTh('Recommended action')}
            </tr></thead>
            <tbody>${sorted.map((s) => `<tr>
                <td class="ict-mono ict-muted">${esc(s.sku)}</td>
                <td>${esc(s.product)} <span class="ict-dim">· ${esc(s.color)}${s.size ? ' · ' + esc(s.size) : ''}</span></td>
                <td class="ict-num">${num(s.currentStock)}</td>
                <td class="ict-num ict-critical-text">${fmtInr(s.value)}</td>
                <td class="ict-num ict-muted">${s.lastSaleDaysAgo == null ? 'Never sold' : s.lastSaleDaysAgo > 84 ? '>84d ago' : s.lastSaleDaysAgo + 'd ago'}</td>
                <td>${pill('critical', (s.ageBucket || '–') + (s.ageBucket ? 'd since launch' : ''))}</td>
                <td class="ict-muted">Bundle, markdown, or write off – see Ageing &amp; Cash tab</td>
            </tr>`).join('')}</tbody></table></div>`;
    }

    function slowTable() {
        const rows = ICT.skus.filter((s) => s.isSlowMover);
        if (!rows.length) return emptyState('No slow movers flagged.');
        const sorted = sortedRows('slow', rows, 'velocity', 'asc').slice(0, 25);
        return `<div class="ict-table-wrap"><table class="ict-table">
            <thead><tr>
                ${th('slow', 'SKU', 'sku')}${th('slow', 'Product / Variant', 'product')}
                ${th('slow', 'Velocity/d', 'velocity', 'right')}${plainTh('Expected/d', 'right')}
                ${th('slow', 'Days of cover', 'daysOfCover', 'right')}${th('slow', 'XYZ', 'xyz')}
            </tr></thead>
            <tbody>${sorted.map((s) => `<tr>
                <td class="ict-mono ict-muted">${esc(s.sku)}</td>
                <td>${esc(s.product)} <span class="ict-dim">· ${esc(s.color)}${s.size ? ' · ' + esc(s.size) : ''}</span></td>
                <td class="ict-num">${s.velocity.toFixed(2)}</td>
                <td class="ict-num ict-dim">below 0.15/d</td>
                <td class="ict-num">${s.daysOfCover === 999 ? '–' : s.daysOfCover + 'd'}</td>
                <td>${pill(s.xyz === 'Z' ? 'critical' : 'attention', s.xyz)}</td>
            </tr>`).join('')}</tbody></table></div>`;
    }

    function productionDelaysList() {
        const rows = ICT.sample.prod.filter((p) => p.status === 'Delayed' || p.status === 'At Risk');
        if (!rows.length) return emptyState('No production delays right now.');
        return `<div class="ict-list">${rows.map((p) => `
            <div class="ict-list-item ${p.status === 'Delayed' ? 'critical' : 'attention'}">
                <div>
                    <div class="ict-list-title">${p.id} · ${esc(p.product)}</div>
                    <div class="ict-list-sub">${esc(p.manufacturer)} · ${num(p.planned)} units · currently at ${p.currentStage}</div>
                </div>
                <div class="ict-list-right">
                    ${pill(p.status === 'Delayed' ? 'critical' : 'attention', p.status)}
                    <div class="ict-list-deadline">Deadline ${p.deadline} ${p.deadlineDays < 0 ? `· ${Math.abs(p.deadlineDays)}d overdue` : `· ${p.deadlineDays}d left`}</div>
                </div>
            </div>`).join('')}</div>`;
    }

    function cashAtRiskPanel() {
        const { agg } = ICT;
        const rows = [...ICT.skus.filter((s) => s.isDead), ...ICT.skus.filter((s) => s.isOverstock)]
            .map((s) => ({ ...s, lockedValue: s.currentStock * s.landedCost }))
            .sort((a, b) => b.lockedValue - a.lockedValue).slice(0, 12);
        return `
            <div class="ict-mini-stats">
                ${statCard('Locked in dead stock', fmtInr(agg.deadStockValue), '', 'critical')}
                ${statCard('Locked in overstock', fmtInr(agg.overstockValue), '', 'attention')}
                ${statCard('Total cash at risk', fmtInr(agg.cashAtRisk), `${agg.invValuePctSales.toFixed(1)}% of run-rate revenue · ${AT_PRICE_NOTE}`, 'critical')}
            </div>
            ${rows.length ? `<div class="ict-table-wrap"><table class="ict-table">
                <thead><tr>${plainTh('SKU')}${plainTh('Product')}${plainTh('Units', 'right')}${plainTh('Value locked', 'right')}${plainTh('Why')}</tr></thead>
                <tbody>${rows.map((s) => `<tr>
                    <td class="ict-mono ict-muted">${esc(s.sku)}</td>
                    <td>${esc(s.product)} <span class="ict-dim">· ${esc(s.color)}${s.size ? ' · ' + esc(s.size) : ''}</span></td>
                    <td class="ict-num">${num(s.currentStock)}</td>
                    <td class="ict-num ict-critical-text">${fmtInr(s.lockedValue)}</td>
                    <td>${pill(s.isDead ? 'critical' : 'attention', s.isDead ? 'Dead stock' : 'Overstock')}</td>
                </tr>`).join('')}</tbody></table></div>` : emptyState('No cash locked in dead or excess stock.')}
        `;
    }

    function renderNeedsAttention() {
        const counts = ICT.data.summary.counts;
        const active = ICT.ui.attention;
        const tabs = [
            { id: 'stockout', label: `Stockout risk (${counts.stockout_risk})` },
            { id: 'overstock', label: `Overstock (${counts.overstock})` },
            { id: 'dead', label: `Dead stock (${counts.dead})` },
            { id: 'slow', label: `Slow movers (${counts.slow_mover})` },
            { id: 'production', label: `Production delays (${ICT.agg.delayedProd + ICT.agg.atRiskProd})` },
            { id: 'cash', label: 'Cash at risk' },
        ];
        const bodies = { stockout: stockoutTable, overstock: overstockTable, dead: deadTable, slow: slowTable, production: productionDelaysList, cash: cashAtRiskPanel };
        return `
            <div class="ict-page-head">
                <h2>What needs attention?</h2>
                <p>Exception management, not dashboard-staring — this is the only list that matters today.</p>
            </div>
            <div class="ict-chip-row">${tabs.map((t) =>
                `<button class="ict-chip ${active === t.id ? 'active' : ''}" data-ict="attention" data-value="${t.id}">${t.id === 'production' ? t.label + ' ' + SAMPLE_BADGE : esc(t.label)}</button>`).join('')}
            </div>
            ${sectionCard('', '', bodies[active]())}`;
    }

    /* ============================ TAB 3 — MASTER INVENTORY ============================ */
    async function loadMovements() {
        const m = ICT.ui.master;
        if (!m.dateFrom) { ICT.movements = null; renderCurrentTab(); return; }
        ICT.movementsLoading = true;
        renderCurrentTab();
        try {
            if (typeof apiCall !== 'function') throw new Error('Hub API client unavailable');
            const params = `from=${m.dateFrom}${m.dateTo ? '&to=' + m.dateTo : ''}`;
            const data = await apiCall(`/inventory/movements?${params}`);
            if (!data || data.success === false) throw new Error((data && data.error) || 'Failed to load movements');
            ICT.movements = data;
        } catch (err) {
            console.error('Movement load error:', err);
            ICT.movements = { error: err.message || 'Failed to load', movements: [], totals: { in: 0, out: 0 }, sku_count: 0 };
        } finally {
            ICT.movementsLoading = false;
            renderCurrentTab();
        }
    }

    function movementsSection() {
        const m = ICT.ui.master;
        const today = new Date().toISOString().slice(0, 10);
        const loading = ICT.movementsLoading;
        const data = ICT.movements;

        let bodyHtml = '';
        if (!m.dateFrom) {
            bodyHtml = `<div class="ict-empty">Select a date to view inventory movements.</div>`;
        } else if (loading) {
            bodyHtml = `<div class="inv-loading"><div class="inv-spinner"></div><span>Loading movements...</span></div>`;
        } else if (data && data.error) {
            bodyHtml = `<div class="ict-error">${esc(data.error)}</div>`;
        } else if (data && data.movements && data.movements.length === 0) {
            bodyHtml = `<div class="ict-empty">No inventory movements recorded for ${esc(m.dateFrom)}${m.dateTo && m.dateTo !== m.dateFrom ? ' — ' + esc(m.dateTo) : ''}.</div>`;
        } else if (data && data.movements) {
            const dateLabel = m.dateTo && m.dateTo !== m.dateFrom ? `${esc(m.dateFrom)} → ${esc(m.dateTo)}` : esc(m.dateFrom);
            const mvRows = data.movements.map((mv) => {
                const inParts = [];
                if (mv.in_breakdown.rto) inParts.push(`${num(mv.in_breakdown.rto)} RTO`);
                if (mv.in_breakdown.returns) inParts.push(`${num(mv.in_breakdown.returns)} returns`);
                if (mv.in_breakdown.exchange_in) inParts.push(`${num(mv.in_breakdown.exchange_in)} exch`);
                if (mv.in_breakdown.manual_in) inParts.push(`${num(mv.in_breakdown.manual_in)} manual`);
                const outParts = [];
                if (mv.out_breakdown.delivered) outParts.push(`${num(mv.out_breakdown.delivered)} sold`);
                if (mv.out_breakdown.exchange_out) outParts.push(`${num(mv.out_breakdown.exchange_out)} exch`);
                if (mv.out_breakdown.manual_out) outParts.push(`${num(mv.out_breakdown.manual_out)} manual`);
                return `<tr>
                    <td class="ict-mono ict-muted">${esc(mv.sku || '–')}</td>
                    <td>${esc(mv.product)}${mv.color ? ` <span class="ict-dim">· ${esc(mv.color)}</span>` : ''}${mv.size ? ` <span class="ict-dim">· ${esc(mv.size)}</span>` : ''}</td>
                    <td class="ict-num ict-healthy-text" style="font-weight:600">${num(mv.qty_in)}</td>
                    <td class="ict-num ict-muted" style="font-size:0.8em">${inParts.join(' · ') || '–'}</td>
                    <td class="ict-num ict-critical-text" style="font-weight:600">${num(mv.qty_out)}</td>
                    <td class="ict-num ict-muted" style="font-size:0.8em">${outParts.join(' · ') || '–'}</td>
                    <td class="ict-num" style="font-weight:600">${mv.qty_in - mv.qty_out > 0 ? '+' : ''}${num(mv.qty_in - mv.qty_out)}</td>
                </tr>`;
            }).join('');

            bodyHtml = `
                <div class="ict-mini-stats">
                    ${statCard('Total IN', num(data.totals.in), `${data.sku_count} SKUs with movement`, 'healthy')}
                    ${statCard('Total OUT', num(data.totals.out), `${data.sku_count} SKUs`, 'critical')}
                    ${statCard('Net movement', `${data.totals.in - data.totals.out > 0 ? '+' : ''}${num(data.totals.in - data.totals.out)}`, `for ${dateLabel}`, data.totals.in - data.totals.out >= 0 ? 'healthy' : 'critical')}
                </div>
                <div class="ict-table-wrap"><table class="ict-table">
                    <thead><tr>
                        ${plainTh('SKU')}${plainTh('Product')}
                        <th class="ict-th-right">Qty IN</th>${plainTh('IN breakdown')}
                        <th class="ict-th-right">Qty OUT</th>${plainTh('OUT breakdown')}
                        ${plainTh('Net', 'right')}
                    </tr></thead>
                    <tbody>${mvRows}</tbody>
                </table></div>
                <div class="ict-foot-note">IN = RTO + customer returns + exchange replacements + manual stock-in · OUT = delivered orders + exchange outgoing + manual stock-out</div>`;
        }

        return `
            <div class="ict-card" style="margin-top:16px">
                <div style="padding:16px 20px 0">
                    <h3 style="margin:0 0 4px;font-size:1rem;font-weight:600;color:var(--ict-text)">SKU-wise Inventory Movements</h3>
                    <p style="margin:0 0 12px;font-size:0.82rem;color:var(--ict-text-muted)">View stock IN and OUT for each SKU on a specific date or date range.</p>
                    <div class="ict-toolbar" style="padding:0 0 12px">
                        <label style="font-size:0.82rem;color:var(--ict-text-muted);display:flex;align-items:center;gap:6px">
                            From
                            <input type="date" class="ict-input" style="width:auto" data-ict-input="mv-from" value="${esc(m.dateFrom)}" max="${today}">
                        </label>
                        <label style="font-size:0.82rem;color:var(--ict-text-muted);display:flex;align-items:center;gap:6px">
                            To
                            <input type="date" class="ict-input" style="width:auto" data-ict-input="mv-to" value="${esc(m.dateTo || '')}" min="${esc(m.dateFrom || '')}" max="${today}">
                        </label>
                        <button class="ict-chip ${m.dateFrom ? 'active' : ''}" data-ict="load-movements" style="margin-left:4px">Load movements</button>
                        ${m.dateFrom ? `<button class="ict-chip" data-ict="clear-movements" style="margin-left:2px">Clear</button>` : ''}
                        ${data && data.movements && data.movements.length > 0 ? `<button class="ict-chip" data-ict="export-movements" style="margin-left:4px;background:#fff;color:#000;font-weight:600">↓ Export CSV</button>` : ''}
                    </div>
                </div>
                ${bodyHtml}
            </div>`;
    }

    function renderMaster() {
        const { skus } = ICT;
        const m = ICT.ui.master;
        const productOptions = ['All', ...new Set(skus.map((s) => s.product))];
        const statusOptions = ['All', 'Healthy', 'Stockout risk', 'Out of stock', 'Overstock', 'Slow mover', 'Dead'];
        const abcOptions = ['All', 'A', 'B', 'C'];

        const filtered = skus.filter((s) => {
            if (m.product !== 'All' && s.product !== m.product) return false;
            if (m.abc !== 'All' && s.abc !== m.abc) return false;
            if (m.status !== 'All' && s.status !== m.status) return false;
            if (m.q) {
                const hay = `${s.sku} ${s.product} ${s.color} ${s.size}`.toLowerCase();
                if (!hay.includes(m.q.toLowerCase())) return false;
            }
            return true;
        });
        const sorted = sortedRows('master', filtered, 'sku', 'asc');
        const pageSize = 20;
        const page = Math.min(m.page, Math.max(0, Math.ceil(sorted.length / pageSize) - 1));
        const pageRows = sorted.slice(page * pageSize, page * pageSize + pageSize);

        const detailRow = (s) => {
            const field = (label, value) => `<div class="ict-detail-field"><div class="ict-detail-label">${label}</div><div class="ict-detail-value">${value}</div></div>`;
            return `<tr class="ict-detail-row"><td colspan="12"><div class="ict-detail-grid">
                ${field('Pipeline (circ / RTO / returns)', `${num(s.inTransit)} / ${num(s.rtoIncoming)} / ${num(s.returnIncoming)}`)}
                ${field('Exchange (in / out)', `${num(s.exchangeIncoming)} / ${num(s.exchangeOutgoing)}`)}
                ${field('Final sellable', num(s.finalAvailable))}
                ${field('Selling price / Compare-at', `${inr(s.price)}${s.compareAt ? ' / ' + inr(s.compareAt) : ''}`)}
                ${field('7d / 14d / 30d sales', `${num(s.sales7)} / ${num(s.sales14)} / ${num(s.sales30)}`)}
                ${field('60d / 84d sales', `${num(s.sales60)} / ${num(s.sales90)}`)}
                ${field('Lead time / Safety stock', `${s.leadTime}d (assumed) / ${num(s.safetyStock)}u`)}
                ${field('Reorder point', `${num(s.reorderPoint)}u`)}
                ${field('Forecast (30d, base)', `${Math.round(s.velocity * 30)}u`)}
                ${field('ABC / XYZ', `${s.abc}${s.xyz} · CV ${s.cv}`)}
                ${field('Ageing (since launch)', s.ageingDays != null ? `${num(s.ageingDays)}d · bucket ${s.ageBucket}` : '–')}
                ${field('Last sale', s.lastSaleDaysAgo == null ? 'Never sold' : s.lastSaleDaysAgo > 84 ? '>84 days ago' : `${s.lastSaleDate} (${s.lastSaleDaysAgo}d ago)`)}
                ${field('RTO / return rate', `${s.rtoRatePct}% / ${s.returnRatePct}%`)}
                ${field('Replenishment call', esc(s.rep.bucket))}
                ${field('Stock value', `${fmtInr(s.currentStock * s.landedCost)} · ${AT_PRICE_NOTE}`)}
            </div></td></tr>`;
        };

        const rowsHtml = pageRows.map((s) => {
            const isOpen = m.expanded === s.sku;
            return `<tr class="ict-master-row ${isOpen ? 'open' : ''}" data-ict="expand" data-sku="${esc(s.sku)}">
                <td class="ict-mono ict-muted">${esc(s.sku)}</td>
                <td>${esc(s.product)}</td>
                <td class="ict-muted">${esc(s.color)}${s.size ? ' · ' + esc(s.size) : ''}</td>
                <td class="ict-num">${num(s.currentStock)}</td>
                <td class="ict-num ict-muted">${s.incomingQty || '–'}</td>
                <td class="ict-num">${s.velocity.toFixed(1)}</td>
                <td class="ict-num">${s.daysOfCover === 999 ? '–' : s.daysOfCover}</td>
                <td class="ict-num">${s.sellThrough30}%</td>
                <td><span class="ict-mono ict-muted">${s.abc}${s.xyz}</span></td>
                <td class="ict-num">${fmtInr(s.currentStock * s.landedCost)}</td>
                <td>${pill(statusTone[s.status] || 'neutral', s.status)}</td>
                <td class="ict-chevron">${isOpen ? '▴' : '▾'}</td>
            </tr>${isOpen ? detailRow(s) : ''}`;
        }).join('');

        const untracked = (ICT.data.untracked || []);
        const untrackedHtml = untracked.length ? sectionCard('Unmatched items', 'Line items from orders/returns/exchanges that could not be matched to a Shopify catalog variant',
            `<div class="ict-untracked">${untracked.map((u) =>
                `<div class="ict-untracked-item"><span>${esc(u.title)}${u.size ? ' — ' + esc(u.size) : ''}</span><span class="ict-dim">${[
                    u.in_circulation ? `${u.in_circulation} in transit` : null, u.rto_incoming ? `${u.rto_incoming} RTO` : null,
                    u.return_incoming ? `${u.return_incoming} returns` : null, u.exchange_incoming ? `${u.exchange_incoming} exch-in` : null,
                    u.exchange_outgoing ? `${u.exchange_outgoing} exch-out` : null].filter(Boolean).join(' · ')}</span></div>`).join('')}</div>`) : '';

        return `
            <div class="ict-page-head">
                <h2>Master inventory database</h2>
                <p>One row per variant — ${num(skus.length)} SKUs tracked · click a row for the full field set.</p>
            </div>
            <div class="ict-toolbar">
                <input type="text" class="ict-input" id="ictMasterSearch" placeholder="Search SKU, product, colour..." value="${esc(m.q)}" data-ict-input="master-q" autocomplete="off">
                <select class="ict-input" data-ict-input="master-product">${productOptions.map((d) => `<option ${m.product === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>
                <select class="ict-input" data-ict-input="master-status">${statusOptions.map((d) => `<option ${m.status === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
                <select class="ict-input" data-ict-input="master-abc">${abcOptions.map((d) => `<option ${m.abc === d ? 'selected' : ''} value="${d}">${d === 'All' ? 'All ABC' : 'Class ' + d}</option>`).join('')}</select>
                <span class="ict-toolbar-count">${num(filtered.length)} matching</span>
            </div>
            <div class="ict-card ict-card-flush">
                <div class="ict-table-wrap"><table class="ict-table">
                    <thead><tr>
                        ${th('master', 'SKU', 'sku')}${th('master', 'Product', 'product')}${th('master', 'Colour / Size', 'color')}
                        ${th('master', 'Stock', 'currentStock', 'right')}${th('master', 'Incoming', 'incomingQty', 'right')}
                        ${th('master', 'Vel/d', 'velocity', 'right')}${th('master', 'Cover', 'daysOfCover', 'right')}
                        ${th('master', 'Sell-thru 30d', 'sellThrough30', 'right')}${th('master', 'ABC/XYZ', 'abc')}
                        ${th('master', 'Value', 'currentStock', 'right')}${plainTh('Status')}<th class="ict-th-static"></th>
                    </tr></thead>
                    <tbody>${rowsHtml || `<tr><td colspan="12">${emptyState('No SKUs match these filters.')}</td></tr>`}</tbody>
                </table></div>
                ${paginationHtml('master', page, filtered.length, pageSize)}
            </div>
            ${untrackedHtml}
            ${movementsSection()}`;
    }


    /* ============================ TAB 4 — BUYING & PRODUCTION ============================ */
    function replenishmentSection() {
        const skus = ICT.skus;
        const buckets = ['BUY NOW', 'BUY SOON', 'MONITOR', 'DO NOT BUY', 'OVERSTOCK – DO NOT REPLENISH'];
        const counts = Object.fromEntries(buckets.map((b) => [b, skus.filter((s) => s.rep.bucket === b)]));
        const filter = ICT.ui.repFilter;
        const buyNowValue = counts['BUY NOW'].reduce((a, s) => a + s.rep.purchase_value, 0);
        const buySoonValue = counts['BUY SOON'].reduce((a, s) => a + s.rep.purchase_value, 0);
        const holdValue = counts['MONITOR'].reduce((a, s) => a + s.currentStock * s.landedCost, 0);

        const rows = sortedRows('rep', (counts[filter] || []).map((s) => ({ ...s, purchaseValue: s.rep.purchase_value, daysRemaining: s.daysOfCover === 999 ? 9999 : s.daysOfCover })), 'purchaseValue', 'desc').slice(0, 40);
        return `
            <div class="ict-mini-stats">
                ${statCard('Buy now', fmtInr(buyNowValue), `${counts['BUY NOW'].length} SKUs · critical`, 'critical')}
                ${statCard('Buy soon', fmtInr(buySoonValue), `${counts['BUY SOON'].length} SKUs`, 'attention')}
                ${statCard('Already sufficient (hold)', fmtInr(holdValue), `${counts['MONITOR'].length} SKUs · ${AT_PRICE_NOTE}`, 'healthy')}
            </div>
            <div class="ict-chip-row">${buckets.map((b) => chip(filter === b, `${b} (${counts[b].length})`, `data-value="${b}" data-set="repFilter"`)).join('')}</div>
            <div class="ict-table-wrap"><table class="ict-table">
                <thead><tr>
                    ${th('rep', 'SKU', 'sku')}${th('rep', 'Product / Variant', 'product')}
                    ${th('rep', 'Stock', 'currentStock', 'right')}${th('rep', 'Vel/d', 'velocity', 'right')}
                    ${th('rep', 'Cover', 'daysRemaining', 'right')}${th('rep', 'Lead time', 'leadTime', 'right')}
                    ${th('rep', 'Rec. qty', 'recommended_qty', 'right')}${th('rep', 'Est. value', 'purchaseValue', 'right')}
                    ${th('rep', 'Priority', 'priority')}${plainTh('Reason')}
                </tr></thead>
                <tbody>${rows.map((s) => `<tr>
                    <td class="ict-mono ict-muted">${esc(s.sku)}</td>
                    <td>${esc(s.product)} <span class="ict-dim">· ${esc(s.color)}${s.size ? ' · ' + esc(s.size) : ''}</span></td>
                    <td class="ict-num">${num(s.currentStock)}</td>
                    <td class="ict-num">${s.velocity.toFixed(1)}</td>
                    <td class="ict-num">${s.daysOfCover === 999 ? '–' : s.daysOfCover + 'd'}</td>
                    <td class="ict-num ict-muted">${s.leadTime}d</td>
                    <td class="ict-num ict-strong">${s.rep.recommended_qty || '–'}</td>
                    <td class="ict-num">${s.rep.recommended_qty ? fmtInr(s.rep.purchase_value) : '–'}</td>
                    <td>${pill(classificationTone(s.rep.bucket), s.rep.priority)}</td>
                    <td class="ict-muted">${esc(s.rep.reason)}</td>
                </tr>`).join('') || `<tr><td colspan="10">${emptyState('Nothing in this bucket.')}</td></tr>`}</tbody>
            </table></div>
            <div class="ict-foot-note">Est. value ${AT_PRICE_NOTE} · lead time assumed ${ICT.data.summary.lead_time_days}d</div>`;
    }

    function poSection() {
        const pos = ICT.sample.pos;
        const filter = ICT.ui.poFilter;
        const statuses = ['All', 'Open', 'Partially Received', 'Fully Received', 'Delayed', 'Cancelled'];
        const rows = filter === 'All' ? pos : pos.filter((p) => p.status === filter);
        return `
            <div class="ict-chip-row">${statuses.map((s) =>
                chip(filter === s, s !== 'All' ? `${s} (${pos.filter((p) => p.status === s).length})` : s, `data-value="${s}" data-set="poFilter"`)).join('')}</div>
            <div class="ict-table-wrap"><table class="ict-table">
                <thead><tr>${['PO ID', 'Product', 'Manufacturer', 'Ordered', 'Received', 'Balance', 'Expected', 'Actual', 'Delay', 'Status'].map((h) => plainTh(h)).join('')}</tr></thead>
                <tbody>${rows.map((p) => `<tr>
                    <td class="ict-mono ict-muted">${p.poId}</td>
                    <td>${esc(p.product)}</td>
                    <td class="ict-muted">${esc(p.manufacturer)}</td>
                    <td class="ict-num">${num(p.orderQty)}</td>
                    <td class="ict-num">${num(p.receivedQty)}</td>
                    <td class="ict-num">${num(p.balance)}</td>
                    <td class="ict-muted">${p.expectedDate}</td>
                    <td class="ict-muted">${p.actualDate}</td>
                    <td class="ict-num">${p.daysDelayed ? p.daysDelayed + 'd' : '–'}</td>
                    <td>${pill(PO_STATUS_TONE[p.status], p.status)}</td>
                </tr>`).join('')}</tbody>
            </table></div>`;
    }

    function productionSection() {
        return `<div class="ict-list">${ICT.sample.prod.map((p) => {
            const stageIdx = PROD_STAGES.indexOf(p.currentStage);
            return `<div class="ict-prod-card">
                <div class="ict-prod-head">
                    <div><span class="ict-mono ict-muted">${p.id}</span> <span class="ict-prod-name">${esc(p.product)}</span> <span class="ict-dim">${esc(p.manufacturer)}</span></div>
                    ${pill(p.status === 'Delayed' ? 'critical' : p.status === 'At Risk' ? 'attention' : 'healthy', p.status)}
                </div>
                <div class="ict-stages">${PROD_STAGES.map((stage, i) => `
                    <div class="ict-stage-step">
                        <div class="ict-stage-bar ${i <= stageIdx ? (p.status === 'Delayed' ? 'on-critical' : 'on') : ''}"></div>
                        <span class="${i <= stageIdx ? '' : 'ict-dim'}">${stage}</span>
                    </div>`).join('')}</div>
                <div class="ict-prod-meta">
                    <span>Planned <b class="ict-mono">${num(p.planned)}</b></span>
                    <span>QC passed <b class="ict-mono">${num(p.qcPassed)}</b></span>
                    <span>Packed <b class="ict-mono">${num(p.packed)}</b></span>
                    <span>Dispatched <b class="ict-mono">${num(p.dispatched)}</b></span>
                    <span>Started ${p.productionStart}</span>
                    <span>Deadline ${p.deadline}</span>
                </div>
            </div>`;
        }).join('')}</div>`;
    }

    function materialsSection() {
        const rm = ICT.sample.rawMaterials;
        const qty = ICT.ui.feQty;
        const bom = [
            { name: 'Cotton Single Jersey Fabric (Black)', per: 0.18 },
            { name: 'Rib Fabric – Collar/Cuff', per: 0.03 },
            { name: 'Woven Main Label', per: 1 },
            { name: 'Care Label', per: 1 },
            { name: 'Sewing Thread – Cone', per: 0.02 },
            { name: 'Polybag – Branded', per: 1 },
        ];
        const feasibility = bom.map((b) => {
            const mat = rm.find((r) => r.name === b.name);
            const needed = Math.ceil(qty * b.per);
            const canMake = mat ? Math.floor(mat.closing / b.per) : 0;
            return { ...b, available: mat ? mat.closing : 0, needed, canMake, short: mat ? mat.closing < needed : true };
        });
        const maxUnits = Math.min(...feasibility.map((f) => f.canMake));
        const bottleneck = feasibility.find((f) => f.canMake === maxUnits);
        const topProduct = [...ICT.skus].sort((a, b) => b.sales30 - a.sales30)[0];

        return `
            <div class="ict-table-wrap"><table class="ict-table">
                <thead><tr>${['Material', 'Opening', 'Inward', 'Consumption', 'Wastage', 'Closing', 'Min stock', 'Supplier', 'Status'].map((h) => plainTh(h)).join('')}</tr></thead>
                <tbody>${rm.map((r) => `<tr>
                    <td>${esc(r.name)}</td>
                    <td class="ict-num">${num(r.opening)}</td>
                    <td class="ict-num">${num(r.inward)}</td>
                    <td class="ict-num">${num(r.consumption)}</td>
                    <td class="ict-num ict-dim">${num(r.wastage)}</td>
                    <td class="ict-num ict-strong">${num(r.closing)} ${r.unit}</td>
                    <td class="ict-num ict-dim">${num(r.minStock)}</td>
                    <td class="ict-muted">${esc(r.supplier.split(',')[0])}</td>
                    <td>${pill(r.belowMin ? 'critical' : 'healthy', r.belowMin ? 'Below min' : 'OK')}</td>
                </tr>`).join('')}</tbody>
            </table></div>
            <div class="ict-feasibility">
                <div class="ict-feasibility-head">
                    <h4>Production feasibility check — ${esc(topProduct ? topProduct.product : 'hero product')}</h4>
                    <label class="ict-feasibility-input">Can we produce
                        <input type="number" min="0" value="${qty}" data-ict-input="fe-qty" class="ict-input ict-input-num"> units?
                    </label>
                </div>
                <div class="ict-feasibility-grid">${feasibility.map((f) => `
                    <div class="ict-feasibility-cell ${f.short ? 'short' : ''}" title="${esc(f.name)}">
                        <div class="ict-feasibility-name">${esc(f.name)}</div>
                        <div class="ict-feasibility-max">${num(f.canMake)} u max</div>
                    </div>`).join('')}</div>
                <div class="ict-feasibility-verdict ${maxUnits >= qty ? 'ok' : 'fail'}">
                    ${maxUnits >= qty
                        ? `Yes — raw material on hand supports ${num(maxUnits)} units, comfortably above the ${num(qty)} requested.`
                        : `Not yet — raw material only supports ${num(maxUnits)} units (bottleneck: ${esc(bottleneck ? bottleneck.name : '–')}). Short by ${num(qty - maxUnits)} units.`}
                </div>
            </div>`;
    }

    function suppliersSection() {
        return `<div class="ict-table-wrap"><table class="ict-table">
            <thead><tr>${['Manufacturer', 'Orders', 'On-time %', 'Rejection %', 'Shortage %', 'Avg lead time', 'Lead time var.', 'Cost var.', 'Status'].map((h) => plainTh(h)).join('')}</tr></thead>
            <tbody>${ICT.sample.suppliers.map((s) => `<tr>
                <td>${esc(s.name)}</td>
                <td class="ict-num">${s.orders}</td>
                <td class="ict-num">${s.onTimePct}%</td>
                <td class="ict-num">${s.rejectionPct}%</td>
                <td class="ict-num">${s.shortagePct}%</td>
                <td class="ict-num">${s.avgLeadTime}d</td>
                <td class="ict-num">±${s.leadTimeVariance}d</td>
                <td class="ict-num">${s.costVariancePct > 0 ? '+' : ''}${s.costVariancePct}%</td>
                <td>${pill(s.tone, s.tone === 'healthy' ? 'Reliable' : s.tone === 'attention' ? 'Watch' : 'Risk')}</td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    }

    function campaignsSection() {
        const toneFor = { Ready: 'healthy', Risk: 'attention', 'Not Ready': 'critical' };
        return `<div class="ict-campaign-grid">${ICT.sample.campaigns.map((c) => `
            <div class="ict-campaign-card">
                <div class="ict-campaign-head">
                    <div>${esc(c.name)}</div>
                    ${pill(toneFor[c.readiness], c.readiness)}
                </div>
                <div class="ict-campaign-sub">${esc(c.product)} · starts ${c.startDate} · +${c.upliftPct}% uplift</div>
                <div class="ict-campaign-row"><span>Forecast demand</span><span class="ict-mono">${num(c.forecastUnits)}u</span></div>
                <div class="ict-campaign-row"><span>Available (stock + incoming)</span><span class="ict-mono">${num(c.available)}u</span></div>
            </div>`).join('')}</div>`;
    }

    function renderBuy() {
        const sections = [
            { id: 'buy', label: 'What should we buy?', sample: false },
            { id: 'po', label: 'Purchase order pipeline', sample: true },
            { id: 'prod', label: 'Production pipeline', sample: true },
            { id: 'materials', label: 'Raw materials & feasibility', sample: true },
            { id: 'suppliers', label: 'Supplier scorecard', sample: true },
            { id: 'campaigns', label: 'Campaign readiness', sample: true },
        ];
        const active = ICT.ui.rep;
        const bodies = { buy: replenishmentSection, po: poSection, prod: productionSection, materials: materialsSection, suppliers: suppliersSection, campaigns: campaignsSection };
        return `
            <div class="ict-page-head">
                <h2>Buying &amp; production</h2>
                <p>From "what should we buy" to raw material feasibility — the founder's main decision screen.</p>
            </div>
            <div class="ict-chip-row">${sections.map((s) =>
                `<button class="ict-chip ${active === s.id ? 'active' : ''}" data-ict="rep-section" data-value="${s.id}">${s.label}${s.sample ? ' ' + SAMPLE_BADGE : ''}</button>`).join('')}
            </div>
            ${sectionCard('', '', bodies[active](), { sample: active !== 'buy' })}`;
    }

    /* ============================ TAB 5 — FORECAST ============================ */
    const weightedMovingForecast = (weeks) => {
        const recent = weeks.slice(6, 11);
        const weights = [1, 1.2, 1.5, 1.8, 2.2];
        const wsum = weights.reduce((a, b) => a + b, 0);
        return recent.reduce((a, v, i) => a + v * weights[i], 0) / wsum;
    };

    function buildForecastSeries(rows, horizonDays, scenarioKey) {
        const weeks = Array.from({ length: 12 }, (_, i) => ({
            idx: i - 11, label: `W${i - 11}`,
            actual: rows.reduce((a, s) => a + (s.weeklySales[i] || 0), 0),
            forecast: null,
        }));
        const lastActual = weeks[weeks.length - 1].actual;
        const baseWeeklyForecast = rows.reduce((a, s) => a + weightedMovingForecast(s.weeklySales || new Array(12).fill(0)), 0);
        const mult = SCENARIOS[scenarioKey].mult;
        const horizonWeeks = Math.max(1, Math.ceil(horizonDays / 7));
        weeks[weeks.length - 1] = { ...weeks[weeks.length - 1], forecast: lastActual };
        const future = Array.from({ length: horizonWeeks }, (_, i) => ({
            idx: i + 1, label: `W+${i + 1}`, actual: null,
            forecast: Math.round(baseWeeklyForecast * mult),
        }));
        return [...weeks, ...future];
    }

    function forecastChartSection() {
        const f = ICT.ui.forecast;
        const products = [...new Map(ICT.skus.map((s) => [s.productId, s.product])).entries()];
        if (!products.some(([id]) => id === f.productId)) f.productId = '__all';
        const rows = f.productId === '__all' ? ICT.skus : ICT.skus.filter((s) => s.productId === f.productId);
        const series = buildForecastSeries(rows, f.horizon, f.scenario);
        const horizonUnits = series.filter((w) => w.actual === null).reduce((a, w) => a + (w.forecast || 0), 0);
        const stockoutNote = rows.some((s) => s.currentStock === 0);

        return `
            <div class="ict-toolbar">
                <select class="ict-input" data-ict-input="forecast-product">
                    <option value="__all" ${f.productId === '__all' ? 'selected' : ''}>All products</option>
                    ${products.map(([id, name]) => `<option value="${esc(id)}" ${f.productId === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}
                </select>
                <span class="ict-chip-row">${[7, 14, 30, 60, 90].map((h) =>
                    `<button class="ict-chip ${f.horizon === h ? 'active' : ''}" data-ict="forecast-horizon" data-value="${h}">${h}D</button>`).join('')}</span>
                <span class="ict-chip-row ict-chip-row-right">${Object.keys(SCENARIOS).map((s) =>
                    `<button class="ict-chip ${f.scenario === s ? 'active' : ''}" data-ict="forecast-scenario" data-value="${s}">${SCENARIOS[s].label}</button>`).join('')}</span>
            </div>
            ${lineChartSvg(series)}
            <div class="ict-chart-note">
                <span><b class="ict-mono">${num(horizonUnits)}</b> units forecast over next ${f.horizon}d under ${SCENARIOS[f.scenario].label.toLowerCase()} · weighted off last 5 weeks</span>
                ${stockoutNote ? '<span class="ict-attention-text">Note: demand includes zero-stock variants — treat depletion dates as upper bounds.</span>' : ''}
            </div>`;
    }

    function abcXyzSection() {
        const cells = {};
        ['A', 'B', 'C'].forEach((a) => ['X', 'Y', 'Z'].forEach((x) => { cells[a + x] = { count: 0, value: 0 }; }));
        ICT.skus.forEach((s) => { const c = cells[s.abc + s.xyz]; if (c) { c.count += 1; c.value += s.currentStock * s.landedCost; } });
        const toneMap = { AX: 'healthy', AY: 'info', AZ: 'attention', BX: 'info', BY: 'neutral', BZ: 'attention', CX: 'neutral', CY: 'neutral', CZ: 'critical' };
        return `
            <div class="ict-matrix">${['A', 'B', 'C'].map((r) => ['X', 'Y', 'Z'].map((c) => {
                const key = r + c, cell = cells[key], tone = TONES[toneMap[key]];
                return `<div class="ict-matrix-cell ${tone}">
                    <div class="ict-matrix-key">${key}</div>
                    <div class="ict-matrix-count">${cell.count} <span>SKUs</span></div>
                    <div class="ict-matrix-value">${fmtInr(cell.value)}</div>
                    <div class="ict-matrix-strategy">${ABCXYZ_STRATEGY[key]}</div>
                </div>`;
            }).join('')).join('')}</div>
            <p class="ict-foot-note">Rows: revenue contribution (A = highest). Columns: demand predictability (X = stable, Z = erratic).</p>`;
    }

    function sizeCurveSection() {
        const products = [...new Map(ICT.skus.map((s) => [s.productId, s.product])).entries()];
        const withSizes = ICT.skus.filter((s) => s.size);
        if (!withSizes.length) return emptyState('No size-wise variants found in the catalog.');
        const st = ICT.ui.size;
        if (!st.productId || !products.some(([id]) => id === st.productId)) st.productId = products[0][0];
        const rows = ICT.skus.filter((s) => s.productId === st.productId && s.size);
        const orderRef = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
        const sizes = [...new Set(rows.map((s) => s.size))].sort((a, b) => orderRef.indexOf(a) - orderRef.indexOf(b));
        const totalStock = rows.reduce((a, s) => a + s.currentStock, 0) || 1;
        const totalSales = rows.reduce((a, s) => a + s.sales30, 0) || 1;
        const data = sizes.map((size) => {
            const stock = rows.filter((s) => s.size === size).reduce((a, s) => a + s.currentStock, 0);
            const sales = rows.filter((s) => s.size === size).reduce((a, s) => a + s.sales30, 0);
            const stockPct = +((stock / totalStock) * 100).toFixed(0);
            const salesPct = +((sales / totalSales) * 100).toFixed(0);
            return { size, stockPct, salesPct, mismatch: Math.abs(stockPct - salesPct) };
        });
        const worst = [...data].sort((a, b) => b.mismatch - a.mismatch)[0];
        const groups = data.map((d) => ({
            label: d.size,
            bars: [
                { value: d.stockPct, cls: 'bar-muted', name: 'Stock mix %' },
                { value: d.salesPct, cls: 'bar-brand', name: 'Sales mix %' },
            ],
        }));
        return `
            <div class="ict-toolbar">
                <select class="ict-input" data-ict-input="size-product">
                    ${products.map(([id, name]) => `<option value="${esc(id)}" ${st.productId === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}
                </select>
                <span class="ict-legend"><span class="ict-legend-swatch bar-muted"></span>Stock mix % <span class="ict-legend-swatch bar-brand"></span>Sales mix %</span>
            </div>
            ${groupedBarsSvg(groups)}
            ${worst && worst.mismatch >= 6 ? `<div class="ict-flag">Size mismatch flagged: <b>${esc(worst.size)}</b> is ${worst.salesPct > worst.stockPct ? 'under-bought' : 'over-bought'} vs demand (${worst.stockPct}% of stock vs ${worst.salesPct}% of sales). Skew the next buy toward the sizes with the biggest gap.</div>` : ''}`;
    }

    function renderForecast() {
        return `
            <div class="ict-page-head">
                <h2>Forecast &amp; segmentation</h2>
                <p>What will we need — and which SKUs deserve the tightest management.</p>
            </div>
            ${sectionCard('Demand forecast', 'Weighted off the last 5 weeks so one unusual week can\'t swing the number · real order history', forecastChartSection())}
            <div class="ict-grid-2">
                ${sectionCard('ABC × XYZ segmentation', 'Value contribution × demand predictability', abcXyzSection())}
                ${sectionCard('Size curve mismatch', 'Stock mix vs. sales mix by size', sizeCurveSection())}
            </div>`;
    }

    /* ============================ TAB 6 — AGEING & CASH ============================ */
    function ageingChartHtml() {
        const data = AGE_BUCKETS.map((b) => {
            const rows = ICT.skus.filter((s) => s.ageBucket === b);
            return {
                bucket: b,
                units: rows.reduce((a, s) => a + s.currentStock, 0),
                value: Math.round(rows.reduce((a, s) => a + s.currentStock * s.landedCost, 0) / 1000),
            };
        });
        const maxU = Math.max(1, ...data.map((d) => d.units));
        const maxV = Math.max(1, ...data.map((d) => d.value));
        const groups = data.map((d, i) => ({
            label: d.bucket,
            bars: [
                { value: +(d.units / maxU * 100).toFixed(1), cls: 'bar-muted', name: `${num(d.units)} units` },
                { value: +(d.value / maxV * 100).toFixed(1), cls: i >= 3 ? 'bar-critical' : i >= 2 ? 'bar-attention' : 'bar-brand', name: `${inrL(d.value * 1000)} value` },
            ],
        }));
        return `${groupedBarsSvg(groups, { unit: '' })}
            <div class="ict-legend ict-legend-center">
                <span><span class="ict-legend-swatch bar-muted"></span>Units (rel.)</span>
                <span><span class="ict-legend-swatch bar-brand"></span>Value &lt;61d</span>
                <span><span class="ict-legend-swatch bar-attention"></span>61–90d</span>
                <span><span class="ict-legend-swatch bar-critical"></span>90d+ · cash gets stuck</span>
            </div>
            <div class="ict-foot-note">Ageing uses product launch date as proxy — stock receipt dates are not tracked.</div>`;
    }

    function lostSalesHtml() {
        const rows = ICT.agg.lostSalesSkus.slice(0, 15);
        if (!rows.length) return emptyState('No material lost sales from stockouts right now.');
        return `<div class="ict-table-wrap"><table class="ict-table">
            <thead><tr>${plainTh('SKU')}${plainTh('Product')}${plainTh('Days short', 'right')}${plainTh('Avg daily demand', 'right')}${plainTh('Est. lost units', 'right')}${plainTh('Est. lost revenue', 'right')}</tr></thead>
            <tbody>${rows.map((s) => `<tr>
                <td class="ict-mono ict-muted">${esc(s.sku)}</td>
                <td>${esc(s.product)} <span class="ict-dim">· ${esc(s.color)}${s.size ? ' · ' + esc(s.size) : ''}</span></td>
                <td class="ict-num">${Math.max(0, Math.round(s.leadTime - s.daysOfCover))}d</td>
                <td class="ict-num">${s.velocity.toFixed(1)}</td>
                <td class="ict-num">${num(s.lostUnits)}</td>
                <td class="ict-num ict-critical-text ict-strong">${fmtInr(s.lostRevenue)}</td>
            </tr>`).join('')}</tbody></table></div>`;
    }

    function deadWorkflowHtml() {
        const workflow = buildDeadWorkflow(ICT.skus);
        const { agg } = ICT;
        if (!workflow.length) return emptyState('No dead stock in the workflow.');
        const rows = sortedRows('deadflow', workflow.map((s) => ({
            ...s, value: s.currentStock * s.landedCost,
            recoverable: s.currentStock * s.landedCost * (s.recoveryPct / 100),
        })), 'value', 'desc');
        return `
            <div class="ict-chip-row" style="margin-bottom:0.9rem"><span class="ict-quiet-note">${workflow.length} SKUs · ${fmtInr(agg.deadStockValue)} locked — route each one to an action · workflow status ${SAMPLE_BADGE}</span></div>
            <div class="ict-table-wrap"><table class="ict-table">
                <thead><tr>
                    ${th('deadflow', 'SKU', 'sku')}${th('deadflow', 'Product', 'product')}
                    ${th('deadflow', 'Units', 'currentStock', 'right')}${th('deadflow', 'Value', 'value', 'right')}
                    ${th('deadflow', 'Est. recovery', 'recoverable', 'right')}${th('deadflow', 'Workflow', 'workflowStatus')}
                </tr></thead>
                <tbody>${rows.map((s) => `<tr>
                    <td class="ict-mono ict-muted">${esc(s.sku)}</td>
                    <td>${esc(s.product)} <span class="ict-dim">· ${esc(s.color)}${s.size ? ' · ' + esc(s.size) : ''}</span></td>
                    <td class="ict-num">${num(s.currentStock)}</td>
                    <td class="ict-num ict-critical-text">${fmtInr(s.value)}</td>
                    <td class="ict-num ict-healthy-text">${fmtInr(s.recoverable)} <span class="ict-dim">(${s.recoveryPct}%)</span></td>
                    <td>${pill(DEAD_STATUS_TONE[s.workflowStatus], s.workflowStatus)}</td>
                </tr>`).join('')}</tbody></table></div>`;
    }

    function renderAgeing() {
        const { agg } = ICT;
        const cashInTransitSample = ICT.sample.pos.filter((p) => p.status === 'Open' || p.status === 'Partially Received' || p.status === 'Delayed')
            .reduce((a, p) => a + p.balance, 0) * (ICT.skus.length ? (agg.inventoryValue / Math.max(1, ICT.skus.reduce((x, s) => x + s.currentStock, 0))) : 0);
        return `
            <div class="ict-page-head">
                <h2>Ageing &amp; cash control</h2>
                <p>Understock costs revenue; overstock costs cash. Both live here. · all values ${AT_PRICE_NOTE}</p>
            </div>
            <div class="ict-stats-grid ict-stats-6">
                ${statCard('Total capital in inventory', fmtInr(agg.cashInFG), AT_PRICE_NOTE, 'brand')}
                ${statCard('Capital – finished goods', fmtInr(agg.cashInFG), 'on hand', 'info')}
                ${statCard('Capital – in transit', fmtInr(cashInTransitSample), 'estimated from open POs', 'info')}
                ${statCard('Capital – dead stock', fmtInr(agg.cashInDead), `${ICT.data.summary.counts.dead} SKUs`, 'critical')}
                ${statCard('Capital – excess stock', fmtInr(agg.cashInExcess), `${ICT.data.summary.counts.overstock} SKUs`, 'attention')}
                ${statCard('Cash at risk (total)', fmtInr(agg.cashAtRisk), 'dead + excess', 'critical')}
            </div>
            <div class="ict-grid-2">
                ${sectionCard('Inventory ageing', 'Units and value locked by age bucket (since product launch) — 90+ days is where cash gets stuck', ageingChartHtml())}
                ${sectionCard('Lost sales from stockouts', 'Understock has a cost too, not just overstock', lostSalesHtml())}
            </div>
            ${sectionCard('Dead-stock action workflow', 'Route each dead SKU to an action', deadWorkflowHtml())}`;
    }

    /* ============================ TAB 7 — FOUNDER VIEW ============================ */
    function renderFounder() {
        const { agg, skus, sample } = ICT;
        const worstStockout = agg.lostSalesSkus[0];
        const worstDead = [...skus].filter((s) => s.isDead).sort((a, b) => b.currentStock * b.landedCost - a.currentStock * a.landedCost)[0];
        const worstOverstock = [...agg.overstockSkus].sort((a, b) => (b.currentStock - b.velocity * 60) * b.landedCost - (a.currentStock - a.velocity * 60) * a.landedCost)[0];
        const worstProd = [...sample.prod].sort((a, b) => a.deadlineDays - b.deadlineDays)[0];
        const worstPo = [...sample.pos].filter((p) => p.status === 'Delayed').sort((a, b) => b.daysDelayed - a.daysDelayed)[0];
        const riskyCampaign = sample.campaigns.find((c) => c.readiness !== 'Ready');

        const risks = [
            worstStockout && { text: `${worstStockout.product} · ${worstStockout.color}${worstStockout.size ? ' ' + worstStockout.size : ''} — stockout risk, ${fmtInr(worstStockout.lostRevenue)} in sales at stake`, tone: 'critical' },
            worstDead && { text: `${worstDead.product} · ${worstDead.color}${worstDead.size ? ' ' + worstDead.size : ''} — dead ${worstDead.lastSaleDaysAgo > 84 ? '>84' : worstDead.lastSaleDaysAgo}d, ${fmtInr(worstDead.currentStock * worstDead.landedCost)} locked`, tone: 'critical' },
            worstOverstock && { text: `${worstOverstock.product} · ${worstOverstock.color}${worstOverstock.size ? ' ' + worstOverstock.size : ''} — ${worstOverstock.daysOfCover}d of cover, capital tied up`, tone: 'attention' },
            worstProd && { text: `${worstProd.id} (${worstProd.product}) — ${worstProd.status.toLowerCase()}, deadline ${worstProd.deadline}`, tone: worstProd.status === 'Delayed' ? 'critical' : 'attention', sample: true },
            worstPo && { text: `${worstPo.poId} with ${worstPo.manufacturer.split(',')[0]} — ${worstPo.daysDelayed}d delayed on ${worstPo.product}`, tone: 'critical', sample: true },
        ].filter(Boolean).slice(0, 5);

        const actions = [
            worstStockout && `Approve emergency reorder for ${worstStockout.sku} — lead time ${worstStockout.leadTime}d (assumed), stock runs out in ${Math.floor(worstStockout.daysOfCover)}d`,
            worstDead && `Decide fate of ${worstDead.product} (${worstDead.color}) — clearance, bundle, or write-off`,
            worstOverstock && `Pause replenishment on ${worstOverstock.product} (${worstOverstock.color}${worstOverstock.size ? ' ' + worstOverstock.size : ''}) and plan a markdown`,
            worstProd && `Call ${worstProd.manufacturer.split(',')[0]} on ${worstProd.id} — currently stuck at ${worstProd.currentStage} (sample pipeline)`,
            riskyCampaign && `Review "${riskyCampaign.name}" before launch — readiness is ${riskyCampaign.readiness} (sample campaign)`,
        ].filter(Boolean).slice(0, 5);

        const buyValue = skus.reduce((a, s) => a + (['BUY NOW', 'BUY SOON'].includes(s.rep.bucket) ? s.rep.purchase_value : 0), 0);
        const holdValue = skus.reduce((a, s) => a + (s.rep.bucket === 'MONITOR' ? s.currentStock * s.landedCost : 0), 0);
        const led = (tone) => `<span class="ict-led ict-led-${tone}"></span>`;

        return `
            <div class="ict-founder-panel">
                <div class="ict-founder-top">
                    <div class="ict-founder-eyebrow">${led('healthy')} Inventory control room · ${fmtDate(new Date())}</div>
                    <h2>Today</h2>
                </div>
                <div class="ict-founder-stats">
                    <div><div class="ict-founder-label">Inventory value</div><div class="ict-founder-value">${inrCr(agg.inventoryValue)}</div><div class="ict-founder-sub">${num(agg.totalUnits)} units · ${AT_PRICE_NOTE}</div></div>
                    <div><div class="ict-founder-label">Weeks cover</div><div class="ict-founder-value">${agg.weeksOfSupply.toFixed(1)}w</div></div>
                    <div><div class="ict-founder-label">Sell-through</div><div class="ict-founder-value">${agg.sellThroughAgg.toFixed(0)}%</div><div class="ict-founder-sub">trailing 30 days</div></div>
                    <div><div class="ict-founder-label">Dead stock</div><div class="ict-founder-value">${agg.deadStockPct.toFixed(0)}%</div><div class="ict-founder-sub">${fmtInr(agg.deadStockValue)}</div></div>
                </div>
                <div class="ict-founder-cols">
                    <div>
                        <div class="ict-founder-colhead critical">Needs my attention</div>
                        <div class="ict-founder-list">${risks.map((r) => `
                            <div class="ict-founder-item">${led(r.tone)}<span>${esc(r.text)}${r.sample ? ' ' + SAMPLE_BADGE : ''}</span></div>`).join('')}</div>
                    </div>
                    <div>
                        <div class="ict-founder-colhead">5 decisions I need to make today</div>
                        <div class="ict-founder-list">${actions.map((a, i) => `
                            <div class="ict-founder-item"><span class="ict-founder-num">${i + 1}</span><span>${esc(a)}</span></div>`).join('')}</div>
                    </div>
                </div>
                <div class="ict-founder-tiles">
                    <div class="ict-founder-tile"><div class="ict-founder-tile-label">Buy</div><div class="ict-founder-tile-value">${fmtInr(buyValue)}</div></div>
                    <div class="ict-founder-tile"><div class="ict-founder-tile-label">Hold</div><div class="ict-founder-tile-value">${fmtInr(holdValue)}</div></div>
                    <div class="ict-founder-tile"><div class="ict-founder-tile-label">Clear</div><div class="ict-founder-tile-value">${fmtInr(agg.deadStockValue)}</div></div>
                    <div class="ict-founder-tile critical"><div class="ict-founder-tile-label">Cash at risk</div><div class="ict-founder-tile-value">${fmtInr(agg.cashAtRisk)}</div></div>
                </div>
            </div>
            <div class="ict-stats-grid">
                ${statCard('Stockouts at risk', fmtInr(agg.totalLostRevenue), 'potential lost sales', 'critical')}
                ${statCard('Excess inventory', fmtInr(agg.overstockValue), '', 'attention')}
                ${statCard('Buying required', fmtInr(buyValue), AT_PRICE_NOTE, 'info')}
                ${statCard('Production delays', String(agg.delayedProd + agg.atRiskProd), 'orders flagged · sample', 'attention')}
            </div>`;
    }


    /* ------------------------------ orchestration ------------------------------ */
    const TAB_RENDERERS = {
        home: renderCommandCenter,
        attention: renderNeedsAttention,
        master: renderMaster,
        stockroom: function() { return '<div id="srMain"><div class="sr-loading"><div class="inv-spinner"></div><span>Loading stock room...</span></div></div>'; },
        buy: renderBuy,
        forecast: renderForecast,
        ageing: renderAgeing,
        founder: renderFounder,
    };

    function renderCurrentTab() {
        const main = document.getElementById('ictMain');
        if (!main) return;
        // Stock Room tab doesn't require ICT.data
        if (!ICT.data && ICT.tab !== 'stockroom') return;
        const renderer = TAB_RENDERERS[ICT.tab];
        main.innerHTML = renderer ? renderer() : '';
        document.querySelectorAll('#ictTabs .ict-tab').forEach((b) =>
            b.classList.toggle('active', b.dataset.tab === ICT.tab));
        // Activate/deactivate Stock Room module
        if (ICT.tab === 'stockroom') {
            if (window.StockRoom) window.StockRoom.activate();
            // Hide status line/footer for stock room
            const sl = document.getElementById('ictStatusLine');
            const ft = document.getElementById('ictFooter');
            if (sl) sl.textContent = '';
            if (ft) ft.innerHTML = '';
        } else {
            if (window.StockRoom) window.StockRoom.deactivate();
            renderStatusLine();
        }
    }

    function renderStatusLine() {
        const el = document.getElementById('ictStatusLine');
        if (!el || !ICT.data) return;
        const generatedAt = new Date(ICT.data.generated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        const windowLabel = ICT.data.window_days > 0 ? `last ${ICT.data.window_days} days` : 'all time';
        const rs = ICT.data.returns_server;
        let rsLine = '';
        if (rs && rs.connected) {
            const u = rs.units || {};
            rsLine = ` · Portal returns server: ${rs.open_requests} open requests (${u.return_incoming || 0} returns · ${u.exchange_incoming || 0} exch-in · ${u.exchange_outgoing || 0} exch-out)`;
        } else if (rs) {
            rsLine = ` · Portal returns server: offline (${rs.reason || 'unreachable'})`;
        }
        el.textContent = `${ICT.data.cached ? 'Cached snapshot' : 'Live snapshot'} · generated ${generatedAt} IST · pipeline window: ${windowLabel} · velocity: trailing 84 days${rsLine}`;
        const asOf = document.getElementById('ictAsOf');
        if (asOf) asOf.textContent = `Live as of ${fmtDate(new Date())}`;
        const footer = document.getElementById('ictFooter');
        if (footer) footer.innerHTML =
            `Velocity, cover, classification & forecasts derive from real order history. ` +
            `Sections marked <span class="ict-sample-badge">SAMPLE</span> are illustrative — purchase orders, production, raw materials, suppliers and campaigns are not connected yet. ` +
            `Assumed manufacturer lead time: ${ICT.data.summary.lead_time_days} days · monetary values at selling price.`;
    }

    async function loadTower(force = false) {
        if (ICT.loading) return;
        ICT.loading = true;
        const main = document.getElementById('ictMain');
        if (main) main.innerHTML = `<div class="inv-loading"><div class="inv-spinner"></div><span>Reconciling stock, sales velocity, RTOs, returns &amp; exchanges...</span></div>`;
        try {
            if (typeof apiCall !== 'function') throw new Error('Hub API client unavailable');
            const data = await apiCall(`/inventory?window=${ICT.windowDays}${force ? '&refresh=1' : ''}`);
            if (!data || data.success === false) throw new Error((data && data.error) || 'Failed to load inventory');
            ICT.data = data;
            ICT.skus = mapSkus(data);
            ICT.sample = buildSampleData(ICT.skus);
            ICT.agg = computeAggregates(ICT.skus, ICT.sample.pos, ICT.sample.prod);
            renderCurrentTab();
        } catch (err) {
            if (main) main.innerHTML = `<div class="ict-error">Could not load the inventory control tower — ${esc(err.message || 'unknown error')}</div>`;
        } finally {
            ICT.loading = false;
        }
    }

    /* -------------------------------- CSV export -------------------------------- */
    function exportTowerCsv() {
        if (!ICT.data) return;
        const headers = ['Product', 'Variant', 'SKU Code', 'Price', 'On Hand', 'In Circulation', 'Delivered (window)',
            'RTO Incoming', 'Returns Incoming', 'Exchange Incoming', 'Exchange Outgoing', 'Final Available',
            'Stock Value', 'Velocity/d', 'Days of Cover', 'Sell-thru 30d %', 'Sales 30d', 'ABC', 'XYZ',
            'Ageing Days', 'Status', 'Replenishment Bucket', 'Recommended Qty', 'Est. Purchase Value',
            'RTO Rate %', 'Return Rate %'];
        const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lines = [headers.join(',')];
        for (const p of ICT.data.products) {
            for (const v of p.variants) {
                lines.push([p.title, v.title, v.sku_code, v.price, v.on_hand, v.in_circulation, v.delivered,
                    v.rto_incoming, v.return_incoming, v.exchange_incoming, v.exchange_outgoing,
                    v.final_available, v.stock_value, v.velocity, v.days_of_cover, v.sell_through_30,
                    v.sales30, v.abc, v.xyz, v.ageing_days ?? '', v.status, v.replenishment.bucket,
                    v.replenishment.recommended_qty, v.replenishment.purchase_value,
                    v.rto_rate_pct, v.return_rate_pct].map(csvEsc).join(','));
            }
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `inventory-control-tower-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function exportMovementsCsv() {
        const data = ICT.movements;
        if (!data || !data.movements || data.movements.length === 0) return;
        const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const headers = ['SKU', 'Product', 'Color', 'Size', 'Qty IN', 'IN: RTO', 'IN: Returns', 'IN: Exchange', 'IN: Manual',
            'Qty OUT', 'OUT: Sold', 'OUT: Exchange', 'OUT: Manual', 'Net'];
        const lines = [headers.join(',')];
        for (const mv of data.movements) {
            const net = mv.qty_in - mv.qty_out;
            lines.push([
                mv.sku, mv.product, mv.color, mv.size,
                mv.qty_in, mv.in_breakdown.rto, mv.in_breakdown.returns, mv.in_breakdown.exchange_in, mv.in_breakdown.manual_in,
                mv.qty_out, mv.out_breakdown.delivered, mv.out_breakdown.exchange_out, mv.out_breakdown.manual_out,
                net
            ].map(csvEsc).join(','));
        }
        // Add summary row
        lines.push('');
        lines.push(['SUMMARY', '', '', '', data.totals.in, '', '', '', '', data.totals.out, '', '', '', data.totals.in - data.totals.out].map(csvEsc).join(','));
        lines.push(['', '', '', '', `${data.sku_count} SKUs`, '', '', '', '', `${data.sku_count} SKUs`, '', '', '', ''].map(csvEsc).join(','));
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dateRange = data.from === data.to ? data.from : `${data.from}_to_${data.to}`;
        a.download = `inventory-movements-${dateRange}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    /* ------------------------------ event wiring ------------------------------ */
    // All interactions are delegated (no inline handlers — CSP-safe).
    document.addEventListener('click', (e) => {
        // Tab clicks must work even before inventoryView is rendered (e.g. Stock Room)
        const tab = e.target.closest('#ictTabs .ict-tab');
        if (tab) { ICT.tab = tab.dataset.tab; renderCurrentTab(); return; }

        const view = document.getElementById('inventoryView');
        if (!view || view.style.display === 'none') return;

        const el = e.target.closest('[data-ict]');
        if (!el || !ICT.data) return;
        const action = el.dataset.ict;

        if (action === 'sort') {
            const tableId = el.dataset.table, key = el.dataset.key;
            const st = ICT.ui.sort[tableId];
            if (st && st.key === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
            else ICT.ui.sort[tableId] = { key, dir: 'desc' };
            renderCurrentTab();
        } else if (action === 'chip') {
            const set = el.dataset.set;
            if (set) { ICT.ui[set] = el.dataset.value; renderCurrentTab(); }
        } else if (action === 'attention') {
            ICT.ui.attention = el.dataset.value; renderCurrentTab();
        } else if (action === 'rep-section') {
            ICT.ui.rep = el.dataset.value; renderCurrentTab();
        } else if (action === 'forecast-horizon') {
            ICT.ui.forecast.horizon = parseInt(el.dataset.value, 10) || 30; renderCurrentTab();
        } else if (action === 'forecast-scenario') {
            ICT.ui.forecast.scenario = el.dataset.value; renderCurrentTab();
        } else if (action === 'expand') {
            const sku = el.dataset.sku;
            ICT.ui.master.expanded = ICT.ui.master.expanded === sku ? null : sku;
            renderCurrentTab();
        } else if (action === 'page') {
            const state = ICT.ui.master;
            state.page = Math.max(0, state.page + (parseInt(el.dataset.dir, 10) || 0));
            renderCurrentTab();
        } else if (action === 'load-movements') {
            loadMovements();
        } else if (action === 'clear-movements') {
            ICT.ui.master.dateFrom = ''; ICT.ui.master.dateTo = ''; ICT.movements = null; renderCurrentTab();
        } else if (action === 'export-movements') {
            exportMovementsCsv();
        }
    });

    document.addEventListener('input', (e) => {
        const el = e.target.closest('[data-ict-input]');
        if (!el || !ICT.data) return;
        const key = el.dataset.ictInput;
        if (key === 'master-q') { ICT.ui.master.q = el.value; ICT.ui.master.page = 0; renderCurrentTab(); const input = document.getElementById('ictMasterSearch'); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }
        else if (key === 'fe-qty') { ICT.ui.feQty = Math.max(0, parseInt(el.value, 10) || 0); renderCurrentTab(); const numInput = document.querySelector('[data-ict-input="fe-qty"]'); if (numInput) numInput.focus(); }
    });

    document.addEventListener('change', (e) => {
        const el = e.target.closest('[data-ict-input]');
        if (!el || !ICT.data) return;
        const key = el.dataset.ictInput;
        if (key === 'master-product') { ICT.ui.master.product = el.value; ICT.ui.master.page = 0; }
        else if (key === 'master-status') { ICT.ui.master.status = el.value; ICT.ui.master.page = 0; }
        else if (key === 'master-abc') { ICT.ui.master.abc = el.value; ICT.ui.master.page = 0; }
        else if (key === 'mv-from') { ICT.ui.master.dateFrom = el.value; ICT.ui.master.page = 0; }
        else if (key === 'mv-to') { ICT.ui.master.dateTo = el.value; }
        else if (key === 'forecast-product') { ICT.ui.forecast.productId = el.value; }
        else if (key === 'size-product') { ICT.ui.size.productId = el.value; }
        else return;
        renderCurrentTab();
    });

    // Header controls (IDs live in index.html)
    document.getElementById('invRefreshBtn')?.addEventListener('click', () => loadTower(true));
    document.getElementById('invExportBtn')?.addEventListener('click', exportTowerCsv);
    document.getElementById('invWindowPills')?.addEventListener('click', (e) => {
        const pillEl = e.target.closest('.inv-pill');
        if (!pillEl) return;
        ICT.windowDays = parseInt(pillEl.dataset.window, 10) || 0;
        document.querySelectorAll('#invWindowPills .inv-pill').forEach((b) => b.classList.toggle('active', b === pillEl));
        loadTower();
    });

    /* --------------------------------- public API --------------------------------- */
    window.InventoryTower = {
        open() { if (!ICT.data) loadTower(); else renderCurrentTab(); },
        refresh: loadTower,
    };
})();

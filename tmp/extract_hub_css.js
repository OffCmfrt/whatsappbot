// One-off: extract inline <style> blocks from page.shoppers.liquid into
// assets/shoppers-hub.css so the template drops below Shopify's 256 KB limit.
const fs = require('fs');
const path = require('path');

const liquidPath = path.join(__dirname, '..', 'page.shoppers.liquid');
const cssPath = path.join(__dirname, '..', 'assets', 'shoppers-hub.css');

const lines = fs.readFileSync(liquidPath, 'utf8').split('\n');

// Locate every <style> ... </style> block (line-indexed)
const blocks = [];
let start = -1;
lines.forEach((line, i) => {
    if (start === -1 && line.trim() === '<style>') start = i;
    else if (start !== -1 && line.trim() === '</style>') {
        blocks.push({ start, end: i });
        start = -1;
    }
});
if (blocks.length !== 2) {
    console.error(`❌ Expected 2 style blocks, found ${blocks.length}`);
    process.exit(1);
}

// Safety: extracted CSS must not contain Liquid expressions
const cssParts = blocks.map(b => lines.slice(b.start + 1, b.end).join('\n'));
for (const css of cssParts) {
    if (css.includes('{{') || css.includes('{%')) {
        console.error('❌ Style block contains Liquid — aborting');
        process.exit(1);
    }
}

fs.writeFileSync(cssPath, [
    '/* OFFCOMFRT Shoppers Hub — extracted from page.shoppers.liquid to stay',
    '   under Shopify\'s 256 KB template limit. Load via asset_url link tag. */',
    cssParts[0],
    '',
    '/* Team View (was an inline <style> inside #teamView) */',
    cssParts[1],
    ''
].join('\n'), 'utf8');

// Replace block 1 with a stylesheet <link>; drop block 2 entirely
const LINK = `    <link rel="stylesheet" href="{{ 'shoppers-hub.css' | asset_url }}?v=1755100000">`;
const keep = [];
for (let i = 0; i < lines.length; i++) {
    const [b1, b2] = blocks;
    if (i === b1.start) { keep.push(LINK); continue; }
    if (i > b1.start && i <= b1.end) continue;
    if (i >= b2.start && i <= b2.end) continue;
    keep.push(lines[i]);
}
fs.writeFileSync(liquidPath, keep.join('\n'), 'utf8');

const newSize = fs.statSync(liquidPath).size;
const cssSize = fs.statSync(cssPath).size;
console.log(`✅ CSS extracted: assets/shoppers-hub.css (${(cssSize / 1024).toFixed(1)} KB)`);
console.log(`✅ Liquid now: ${(newSize / 1024).toFixed(1)} KB (limit 256 KB)`);
if (newSize >= 262144) { console.error('❌ Still over limit'); process.exit(1); }
console.log('🎉 Under the 256 KB Shopify template limit');

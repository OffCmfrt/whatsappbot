/**
 * Seed Manual Inventory from the September 2026 Inventory Sheet
 * 
 * This script syncs the manual_inventory table with the closing stock
 * values from "NEW Daily Inventory Report September (1) (1).xlsx"
 * using the September 4th data (latest available).
 * 
 * Usage: node scripts/seed_manual_inventory_sept2026.js
 */

require('dotenv').config();
const { dbAdapter } = require('../src/database/db');

// Inventory data extracted from the Excel sheet (September 4 closing stock)
// Format: { product_name, category, size, sku_key, quantity, reorder_level }
const INVENTORY_DATA = [
    // WAFFLE - 001 (B)
    { product_name: 'WAFFLE - 001 ( B )', category: 'T-SHIRT', size: 'S', sku_key: 'waffle-001-b-s', quantity: 25, reorder_level: 60 },
    { product_name: 'WAFFLE - 001 ( B )', category: 'T-SHIRT', size: 'M', sku_key: 'waffle-001-b-m', quantity: 136, reorder_level: 100 },
    { product_name: 'WAFFLE - 001 ( B )', category: 'T-SHIRT', size: 'L', sku_key: 'waffle-001-b-l', quantity: 165, reorder_level: 100 },
    { product_name: 'WAFFLE - 001 ( B )', category: 'T-SHIRT', size: 'XL', sku_key: 'waffle-001-b-xl', quantity: 110, reorder_level: 60 },
    { product_name: 'WAFFLE - 001 ( B )', category: 'T-SHIRT', size: 'XS', sku_key: 'waffle-001-b-xs', quantity: 199, reorder_level: 60 },

    // WAFFLE - 001 (W)
    { product_name: 'WAFFLE - 001 ( W )', category: 'T-SHIRT', size: 'S', sku_key: 'waffle-001-w-s', quantity: 254, reorder_level: 60 },
    { product_name: 'WAFFLE - 001 ( W )', category: 'T-SHIRT', size: 'M', sku_key: 'waffle-001-w-m', quantity: 160, reorder_level: 100 },
    { product_name: 'WAFFLE - 001 ( W )', category: 'T-SHIRT', size: 'L', sku_key: 'waffle-001-w-l', quantity: 90, reorder_level: 100 },
    { product_name: 'WAFFLE - 001 ( W )', category: 'T-SHIRT', size: 'XL', sku_key: 'waffle-001-w-xl', quantity: 28, reorder_level: 60 },
    { product_name: 'WAFFLE - 001 ( W )', category: 'T-SHIRT', size: 'XS', sku_key: 'waffle-001-w-xs', quantity: 169, reorder_level: 60 },

    // WAFFLE - 001 (ACID WASH)
    { product_name: 'WAFFLE  - 001(ACID WASH)', category: 'T-SHIRT', size: 'S', sku_key: 'waffle-001-aw-s', quantity: 67, reorder_level: 60 },
    { product_name: 'WAFFLE  - 001(ACID WASH)', category: 'T-SHIRT', size: 'M', sku_key: 'waffle-001-aw-m', quantity: 99, reorder_level: 100 },
    { product_name: 'WAFFLE  - 001(ACID WASH)', category: 'T-SHIRT', size: 'L', sku_key: 'waffle-001-aw-l', quantity: 38, reorder_level: 100 },
    { product_name: 'WAFFLE  - 001(ACID WASH)', category: 'T-SHIRT', size: 'XL', sku_key: 'waffle-001-aw-xl', quantity: 55, reorder_level: 60 },
    { product_name: 'WAFFLE  - 001(ACID WASH)', category: 'T-SHIRT', size: 'XS', sku_key: 'waffle-001-aw-xs', quantity: 178, reorder_level: 60 },

    // HENLEY - 001 (B)
    { product_name: 'HENLEY - 001 ( B )', category: 'T-SHIRT', size: 'S', sku_key: 'henley-001-b-s', quantity: 533, reorder_level: 60 },
    { product_name: 'HENLEY - 001 ( B )', category: 'T-SHIRT', size: 'M', sku_key: 'henley-001-b-m', quantity: 0, reorder_level: 100 },
    { product_name: 'HENLEY - 001 ( B )', category: 'T-SHIRT', size: 'L', sku_key: 'henley-001-b-l', quantity: 150, reorder_level: 100 },
    { product_name: 'HENLEY - 001 ( B )', category: 'T-SHIRT', size: 'XL', sku_key: 'henley-001-b-xl', quantity: 83, reorder_level: 60 },
    { product_name: 'HENLEY - 001 ( B )', category: 'T-SHIRT', size: 'XS', sku_key: 'henley-001-b-xs', quantity: 58, reorder_level: 60 },

    // HENLEY - 001 (W)
    { product_name: 'HENLEY - 001 ( W )', category: 'T-SHIRT', size: 'S', sku_key: 'henley-001-w-s', quantity: 543, reorder_level: 60 },
    { product_name: 'HENLEY - 001 ( W )', category: 'T-SHIRT', size: 'M', sku_key: 'henley-001-w-m', quantity: 35, reorder_level: 100 },
    { product_name: 'HENLEY - 001 ( W )', category: 'T-SHIRT', size: 'L', sku_key: 'henley-001-w-l', quantity: 72, reorder_level: 100 },
    { product_name: 'HENLEY - 001 ( W )', category: 'T-SHIRT', size: 'XL', sku_key: 'henley-001-w-xl', quantity: 103, reorder_level: 60 },
    { product_name: 'HENLEY - 001 ( W )', category: 'T-SHIRT', size: 'XS', sku_key: 'henley-001-w-xs', quantity: 100, reorder_level: 60 },

    // HENLEY - 001 (LIGHT GREY)
    { product_name: 'HENLEY - 001 (LIGHT GREY)', category: 'T-SHIRT', size: 'S', sku_key: 'henley-001-lg-s', quantity: 168, reorder_level: 60 },
    { product_name: 'HENLEY - 001 (LIGHT GREY)', category: 'T-SHIRT', size: 'M', sku_key: 'henley-001-lg-m', quantity: 139, reorder_level: 100 },
    { product_name: 'HENLEY - 001 (LIGHT GREY)', category: 'T-SHIRT', size: 'L', sku_key: 'henley-001-lg-l', quantity: 154, reorder_level: 100 },
    { product_name: 'HENLEY - 001 (LIGHT GREY)', category: 'T-SHIRT', size: 'XL', sku_key: 'henley-001-lg-xl', quantity: 99, reorder_level: 60 },
    { product_name: 'HENLEY - 001 (LIGHT GREY)', category: 'T-SHIRT', size: 'XS', sku_key: 'henley-001-lg-xs', quantity: 69, reorder_level: 60 },

    // HENLEY - 001 (DARK GREY)
    { product_name: 'HENLEY - 001 (DARK GREY)', category: 'T-SHIRT', size: 'S', sku_key: 'henley-001-dg-s', quantity: 8, reorder_level: 60 },
    { product_name: 'HENLEY - 001 (DARK GREY)', category: 'T-SHIRT', size: 'M', sku_key: 'henley-001-dg-m', quantity: 6, reorder_level: 100 },
    { product_name: 'HENLEY - 001 (DARK GREY)', category: 'T-SHIRT', size: 'L', sku_key: 'henley-001-dg-l', quantity: 3, reorder_level: 100 },
    { product_name: 'HENLEY - 001 (DARK GREY)', category: 'T-SHIRT', size: 'XL', sku_key: 'henley-001-dg-xl', quantity: 5, reorder_level: 60 },
    { product_name: 'HENLEY - 001 (DARK GREY)', category: 'T-SHIRT', size: 'XS', sku_key: 'henley-001-dg-xs', quantity: 3, reorder_level: 60 },

    // HENLEY ACID WASH
    { product_name: 'HENLEY ACID WASH', category: 'T-SHIRT', size: 'S', sku_key: 'henley-aw-s', quantity: 579, reorder_level: 60 },
    { product_name: 'HENLEY ACID WASH', category: 'T-SHIRT', size: 'M', sku_key: 'henley-aw-m', quantity: 0, reorder_level: 100 },
    { product_name: 'HENLEY ACID WASH', category: 'T-SHIRT', size: 'L', sku_key: 'henley-aw-l', quantity: 7, reorder_level: 100 },
    { product_name: 'HENLEY ACID WASH', category: 'T-SHIRT', size: 'XL', sku_key: 'henley-aw-xl', quantity: 77, reorder_level: 60 },
    { product_name: 'HENLEY ACID WASH', category: 'T-SHIRT', size: 'XS', sku_key: 'henley-aw-xs', quantity: 173, reorder_level: 60 },

    // VEST-001 EMBRODIARY (B)
    { product_name: 'VEST-001 EMBRODIARY (B)', category: 'T-SHIRT', size: 'S', sku_key: 'vest-001-emb-b-s', quantity: 93, reorder_level: 60 },
    { product_name: 'VEST-001 EMBRODIARY (B)', category: 'T-SHIRT', size: 'M', sku_key: 'vest-001-emb-b-m', quantity: 175, reorder_level: 80 },
    { product_name: 'VEST-001 EMBRODIARY (B)', category: 'T-SHIRT', size: 'L', sku_key: 'vest-001-emb-b-l', quantity: 148, reorder_level: 40 },
    { product_name: 'VEST-001 EMBRODIARY (B)', category: 'T-SHIRT', size: 'XL', sku_key: 'vest-001-emb-b-xl', quantity: 115, reorder_level: 20 },

    // VEST-001 EMBRODIARY (W)
    { product_name: 'VEST-001 EMBRODIARY (W)', category: 'T-SHIRT', size: 'S', sku_key: 'vest-001-emb-w-s', quantity: 235, reorder_level: 60 },
    { product_name: 'VEST-001 EMBRODIARY (W)', category: 'T-SHIRT', size: 'M', sku_key: 'vest-001-emb-w-m', quantity: 269, reorder_level: 80 },
    { product_name: 'VEST-001 EMBRODIARY (W)', category: 'T-SHIRT', size: 'L', sku_key: 'vest-001-emb-w-l', quantity: 189, reorder_level: 40 },
    { product_name: 'VEST-001 EMBRODIARY (W)', category: 'T-SHIRT', size: 'XL', sku_key: 'vest-001-emb-w-xl', quantity: 196, reorder_level: 20 },

    // SLUB-001 FULL SLEEVE (B)
    { product_name: 'SLUB-001 FULL SLEEVE (B)', category: 'T-SHIRT', size: 'S', sku_key: 'slub-001-fs-b-s', quantity: 5, reorder_level: 60 },
    { product_name: 'SLUB-001 FULL SLEEVE (B)', category: 'T-SHIRT', size: 'M', sku_key: 'slub-001-fs-b-m', quantity: 11, reorder_level: 60 },
    { product_name: 'SLUB-001 FULL SLEEVE (B)', category: 'T-SHIRT', size: 'L', sku_key: 'slub-001-fs-b-l', quantity: 18, reorder_level: 40 },
    { product_name: 'SLUB-001 FULL SLEEVE (B)', category: 'T-SHIRT', size: 'XL', sku_key: 'slub-001-fs-b-xl', quantity: 17, reorder_level: 20 },
    { product_name: 'SLUB-001 FULL SLEEVE (B)', category: 'T-SHIRT', size: 'XS', sku_key: 'slub-001-fs-b-xs', quantity: 10, reorder_level: 20 },

    // SLUB-001 FULL SLEEVE (W)
    { product_name: 'SLUB-001 FULL SLEEVE (W)', category: 'T-SHIRT', size: 'S', sku_key: 'slub-001-fs-w-s', quantity: 1, reorder_level: 60 },
    { product_name: 'SLUB-001 FULL SLEEVE (W)', category: 'T-SHIRT', size: 'M', sku_key: 'slub-001-fs-w-m', quantity: 25, reorder_level: 60 },
    { product_name: 'SLUB-001 FULL SLEEVE (W)', category: 'T-SHIRT', size: 'L', sku_key: 'slub-001-fs-w-l', quantity: 25, reorder_level: 40 },
    { product_name: 'SLUB-001 FULL SLEEVE (W)', category: 'T-SHIRT', size: 'XL', sku_key: 'slub-001-fs-w-xl', quantity: 24, reorder_level: 20 },
    { product_name: 'SLUB-001 FULL SLEEVE (W)', category: 'T-SHIRT', size: 'XS', sku_key: 'slub-001-fs-w-xs', quantity: 10, reorder_level: 20 },

    // SLUB-001 FULL SLEEVE (G)
    { product_name: 'SLUB-001 FULL SLEEVE (G)', category: 'T-SHIRT', size: 'S', sku_key: 'slub-001-fs-g-s', quantity: 0, reorder_level: 60 },
    { product_name: 'SLUB-001 FULL SLEEVE (G)', category: 'T-SHIRT', size: 'M', sku_key: 'slub-001-fs-g-m', quantity: 0, reorder_level: 60 },
    { product_name: 'SLUB-001 FULL SLEEVE (G)', category: 'T-SHIRT', size: 'L', sku_key: 'slub-001-fs-g-l', quantity: 0, reorder_level: 40 },
    { product_name: 'SLUB-001 FULL SLEEVE (G)', category: 'T-SHIRT', size: 'XL', sku_key: 'slub-001-fs-g-xl', quantity: 0, reorder_level: 20 },
    { product_name: 'SLUB-001 FULL SLEEVE (G)', category: 'T-SHIRT', size: 'XS', sku_key: 'slub-001-fs-g-xs', quantity: 0, reorder_level: 20 },

    // SLUB FULL SLEEVE ACID WASH
    { product_name: 'SLUB  FULL SLEEVE ACID WASH', category: 'T-SHIRT', size: 'S', sku_key: 'slub-fs-aw-s', quantity: 74, reorder_level: 60 },
    { product_name: 'SLUB  FULL SLEEVE ACID WASH', category: 'T-SHIRT', size: 'M', sku_key: 'slub-fs-aw-m', quantity: 214, reorder_level: 100 },
    { product_name: 'SLUB  FULL SLEEVE ACID WASH', category: 'T-SHIRT', size: 'L', sku_key: 'slub-fs-aw-l', quantity: 111, reorder_level: 100 },
    { product_name: 'SLUB  FULL SLEEVE ACID WASH', category: 'T-SHIRT', size: 'XL', sku_key: 'slub-fs-aw-xl', quantity: 42, reorder_level: 60 },
    { product_name: 'SLUB  FULL SLEEVE ACID WASH', category: 'T-SHIRT', size: 'XS', sku_key: 'slub-fs-aw-xs', quantity: 41, reorder_level: 60 },

    // RAGLAN-001 (B)
    { product_name: 'RAGLAN-001 (B)', category: 'T-SHIRT', size: 'S', sku_key: 'raglan-001-b-s', quantity: 94, reorder_level: 60 },
    { product_name: 'RAGLAN-001 (B)', category: 'T-SHIRT', size: 'M', sku_key: 'raglan-001-b-m', quantity: 90, reorder_level: 100 },
    { product_name: 'RAGLAN-001 (B)', category: 'T-SHIRT', size: 'L', sku_key: 'raglan-001-b-l', quantity: 118, reorder_level: 100 },
    { product_name: 'RAGLAN-001 (B)', category: 'T-SHIRT', size: 'XL', sku_key: 'raglan-001-b-xl', quantity: 109, reorder_level: 60 },
    { product_name: 'RAGLAN-001 (B)', category: 'T-SHIRT', size: 'XS', sku_key: 'raglan-001-b-xs', quantity: 56, reorder_level: 60 },

    // RAGLAN-001 (W)
    { product_name: 'RAGLAN-001 (W)', category: 'T-SHIRT', size: 'S', sku_key: 'raglan-001-w-s', quantity: 176, reorder_level: 60 },
    { product_name: 'RAGLAN-001 (W)', category: 'T-SHIRT', size: 'M', sku_key: 'raglan-001-w-m', quantity: 48, reorder_level: 100 },
    { product_name: 'RAGLAN-001 (W)', category: 'T-SHIRT', size: 'L', sku_key: 'raglan-001-w-l', quantity: 36, reorder_level: 100 },
    { product_name: 'RAGLAN-001 (W)', category: 'T-SHIRT', size: 'XL', sku_key: 'raglan-001-w-xl', quantity: 177, reorder_level: 60 },
    { product_name: 'RAGLAN-001 (W)', category: 'T-SHIRT', size: 'XS', sku_key: 'raglan-001-w-xs', quantity: 145, reorder_level: 60 },

    // RAGLAN-001 (G)
    { product_name: 'RAGLAN-001 (G)', category: 'T-SHIRT', size: 'S', sku_key: 'raglan-001-g-s', quantity: 246, reorder_level: 60 },
    { product_name: 'RAGLAN-001 (G)', category: 'T-SHIRT', size: 'M', sku_key: 'raglan-001-g-m', quantity: 129, reorder_level: 100 },
    { product_name: 'RAGLAN-001 (G)', category: 'T-SHIRT', size: 'L', sku_key: 'raglan-001-g-l', quantity: 119, reorder_level: 100 },
    { product_name: 'RAGLAN-001 (G)', category: 'T-SHIRT', size: 'XL', sku_key: 'raglan-001-g-xl', quantity: 72, reorder_level: 60 },
    { product_name: 'RAGLAN-001 (G)', category: 'T-SHIRT', size: 'XS', sku_key: 'raglan-001-g-xs', quantity: 88, reorder_level: 60 },

    // SWEATSHIRT-001 (G)
    { product_name: 'SWEATSHIRT-001 (G)', category: 'SWEAT', size: 'S', sku_key: 'sweatshirt-001-g-s', quantity: 6, reorder_level: 60 },
    { product_name: 'SWEATSHIRT-001 (G)', category: 'SWEAT', size: 'M', sku_key: 'sweatshirt-001-g-m', quantity: 12, reorder_level: 80 },
    { product_name: 'SWEATSHIRT-001 (G)', category: 'SWEAT', size: 'L', sku_key: 'sweatshirt-001-g-l', quantity: 2, reorder_level: 40 },
    { product_name: 'SWEATSHIRT-001 (G)', category: 'SWEAT', size: 'XL', sku_key: 'sweatshirt-001-g-xl', quantity: 3, reorder_level: 20 },

    // SWEATSHIRT-001 (B)
    { product_name: 'SWEATSHIRT-001 (B)', category: 'SWEAT', size: 'S', sku_key: 'sweatshirt-001-b-s', quantity: 13, reorder_level: 60 },
    { product_name: 'SWEATSHIRT-001 (B)', category: 'SWEAT', size: 'M', sku_key: 'sweatshirt-001-b-m', quantity: 0, reorder_level: 80 },
    { product_name: 'SWEATSHIRT-001 (B)', category: 'SWEAT', size: 'L', sku_key: 'sweatshirt-001-b-l', quantity: 4, reorder_level: 40 },
    { product_name: 'SWEATSHIRT-001 (B)', category: 'SWEAT', size: 'XL', sku_key: 'sweatshirt-001-b-xl', quantity: 1, reorder_level: 20 },

    // WAFFLE TANK -001 (G)
    { product_name: 'WAFFLE TANK -001 (G)', category: 'T-SHIRT', size: 'S', sku_key: 'waffle-tank-001-g-s', quantity: 31, reorder_level: 60 },
    { product_name: 'WAFFLE TANK -001 (G)', category: 'T-SHIRT', size: 'M', sku_key: 'waffle-tank-001-g-m', quantity: 42, reorder_level: 80 },
    { product_name: 'WAFFLE TANK -001 (G)', category: 'T-SHIRT', size: 'L', sku_key: 'waffle-tank-001-g-l', quantity: 21, reorder_level: 40 },
    { product_name: 'WAFFLE TANK -001 (G)', category: 'T-SHIRT', size: 'XL', sku_key: 'waffle-tank-001-g-xl', quantity: 5, reorder_level: 20 },

    // SLUB HALF-001 (B)
    { product_name: 'SLUB  HALF-001 (B)', category: 'T-SHIRT', size: 'S', sku_key: 'slub-half-001-b-s', quantity: 33, reorder_level: 60 },
    { product_name: 'SLUB  HALF-001 (B)', category: 'T-SHIRT', size: 'M', sku_key: 'slub-half-001-b-m', quantity: 38, reorder_level: 60 },
    { product_name: 'SLUB  HALF-001 (B)', category: 'T-SHIRT', size: 'L', sku_key: 'slub-half-001-b-l', quantity: 17, reorder_level: 40 },
    { product_name: 'SLUB  HALF-001 (B)', category: 'T-SHIRT', size: 'XL', sku_key: 'slub-half-001-b-xl', quantity: 6, reorder_level: 20 },
    { product_name: 'SLUB  HALF-001 (B)', category: 'T-SHIRT', size: 'XS', sku_key: 'slub-half-001-b-xs', quantity: 10, reorder_level: 20 },

    // SLUB HALF-001 (W)
    { product_name: 'SLUB HALF-001 ( W)', category: 'T-SHIRT', size: 'S', sku_key: 'slub-half-001-w-s', quantity: 36, reorder_level: 60 },
    { product_name: 'SLUB HALF-001 ( W)', category: 'T-SHIRT', size: 'M', sku_key: 'slub-half-001-w-m', quantity: 36, reorder_level: 60 },
    { product_name: 'SLUB HALF-001 ( W)', category: 'T-SHIRT', size: 'L', sku_key: 'slub-half-001-w-l', quantity: 29, reorder_level: 40 },
    { product_name: 'SLUB HALF-001 ( W)', category: 'T-SHIRT', size: 'XL', sku_key: 'slub-half-001-w-xl', quantity: 28, reorder_level: 20 },
    { product_name: 'SLUB HALF-001 ( W)', category: 'T-SHIRT', size: 'XS', sku_key: 'slub-half-001-w-xs', quantity: 10, reorder_level: 20 },

    // JAQUARD POLO (B)
    { product_name: 'JAQUARD POLO (B)', category: 'T-SHIRT', size: 'S', sku_key: 'jaquard-polo-b-s', quantity: 11, reorder_level: 60 },
    { product_name: 'JAQUARD POLO (B)', category: 'T-SHIRT', size: 'M', sku_key: 'jaquard-polo-b-m', quantity: 14, reorder_level: 80 },
    { product_name: 'JAQUARD POLO (B)', category: 'T-SHIRT', size: 'L', sku_key: 'jaquard-polo-b-l', quantity: 5, reorder_level: 40 },
    { product_name: 'JAQUARD POLO (B)', category: 'T-SHIRT', size: 'XL', sku_key: 'jaquard-polo-b-xl', quantity: 1, reorder_level: 20 },

    // JAQUARD POLO OFF-WHITE
    { product_name: 'JAQUARD POLO  OFF-WHITE', category: 'T-SHIRT', size: 'S', sku_key: 'jaquard-polo-ow-s', quantity: 4, reorder_level: 60 },
    { product_name: 'JAQUARD POLO  OFF-WHITE', category: 'T-SHIRT', size: 'M', sku_key: 'jaquard-polo-ow-m', quantity: 10, reorder_level: 80 },
    { product_name: 'JAQUARD POLO  OFF-WHITE', category: 'T-SHIRT', size: 'L', sku_key: 'jaquard-polo-ow-l', quantity: 2, reorder_level: 40 },
    { product_name: 'JAQUARD POLO  OFF-WHITE', category: 'T-SHIRT', size: 'XL', sku_key: 'jaquard-polo-ow-xl', quantity: 3, reorder_level: 20 },

    // VEST PLAIN (B)
    { product_name: 'VEST PLAIN (B)', category: 'T-SHIRT', size: 'S', sku_key: 'vest-plain-b-s', quantity: 20, reorder_level: 60 },
    { product_name: 'VEST PLAIN (B)', category: 'T-SHIRT', size: 'M', sku_key: 'vest-plain-b-m', quantity: 17, reorder_level: 80 },
    { product_name: 'VEST PLAIN (B)', category: 'T-SHIRT', size: 'L', sku_key: 'vest-plain-b-l', quantity: 9, reorder_level: 40 },
    { product_name: 'VEST PLAIN (B)', category: 'T-SHIRT', size: 'XL', sku_key: 'vest-plain-b-xl', quantity: 5, reorder_level: 20 },

    // VEST PLAIN (W)
    { product_name: 'VEST PLAIN (W)', category: 'T-SHIRT', size: 'S', sku_key: 'vest-plain-w-s', quantity: 18, reorder_level: 60 },
    { product_name: 'VEST PLAIN (W)', category: 'T-SHIRT', size: 'M', sku_key: 'vest-plain-w-m', quantity: 16, reorder_level: 80 },
    { product_name: 'VEST PLAIN (W)', category: 'T-SHIRT', size: 'L', sku_key: 'vest-plain-w-l', quantity: 9, reorder_level: 40 },
    { product_name: 'VEST PLAIN (W)', category: 'T-SHIRT', size: 'XL', sku_key: 'vest-plain-w-xl', quantity: 5, reorder_level: 20 },

    // WAFFLE HALF-001 (B)
    { product_name: 'WAFFLE HALF-001(B)', category: 'T-SHIRT', size: 'S', sku_key: 'waffle-half-001-b-s', quantity: 31, reorder_level: 60 },
    { product_name: 'WAFFLE HALF-001(B)', category: 'T-SHIRT', size: 'M', sku_key: 'waffle-half-001-b-m', quantity: 13, reorder_level: 60 },
    { product_name: 'WAFFLE HALF-001(B)', category: 'T-SHIRT', size: 'L', sku_key: 'waffle-half-001-b-l', quantity: 8, reorder_level: 40 },
    { product_name: 'WAFFLE HALF-001(B)', category: 'T-SHIRT', size: 'XL', sku_key: 'waffle-half-001-b-xl', quantity: 0, reorder_level: 20 },
    { product_name: 'WAFFLE HALF-001(B)', category: 'T-SHIRT', size: 'XS', sku_key: 'waffle-half-001-b-xs', quantity: 28, reorder_level: 20 },

    // WAFFLE HALF-001 (W)
    { product_name: 'WAFFLE HALF-001(W)', category: 'T-SHIRT', size: 'S', sku_key: 'waffle-half-001-w-s', quantity: 25, reorder_level: 60 },
    { product_name: 'WAFFLE HALF-001(W)', category: 'T-SHIRT', size: 'M', sku_key: 'waffle-half-001-w-m', quantity: 27, reorder_level: 60 },
    { product_name: 'WAFFLE HALF-001(W)', category: 'T-SHIRT', size: 'L', sku_key: 'waffle-half-001-w-l', quantity: 28, reorder_level: 40 },
    { product_name: 'WAFFLE HALF-001(W)', category: 'T-SHIRT', size: 'XL', sku_key: 'waffle-half-001-w-xl', quantity: 8, reorder_level: 20 },
    { product_name: 'WAFFLE HALF-001(W)', category: 'T-SHIRT', size: 'XS', sku_key: 'waffle-half-001-w-xs', quantity: 9, reorder_level: 20 },

    // LOWER DARK WASH
    { product_name: 'LOWER DARK WASH', category: 'LOWER', size: 'S', sku_key: 'lower-dw-s', quantity: 6, reorder_level: 60 },
    { product_name: 'LOWER DARK WASH', category: 'LOWER', size: 'M', sku_key: 'lower-dw-m', quantity: 4, reorder_level: 100 },
    { product_name: 'LOWER DARK WASH', category: 'LOWER', size: 'L', sku_key: 'lower-dw-l', quantity: 13, reorder_level: 100 },
    { product_name: 'LOWER DARK WASH', category: 'LOWER', size: 'XL', sku_key: 'lower-dw-xl', quantity: 7, reorder_level: 60 },
    { product_name: 'LOWER DARK WASH', category: 'LOWER', size: 'XS', sku_key: 'lower-dw-xs', quantity: 0, reorder_level: 60 },

    // LOWER GREY
    { product_name: 'LOWER GREY', category: 'LOWER', size: 'S', sku_key: 'lower-grey-s', quantity: 0, reorder_level: 60 },
    { product_name: 'LOWER GREY', category: 'LOWER', size: 'M', sku_key: 'lower-grey-m', quantity: 0, reorder_level: 60 },
    { product_name: 'LOWER GREY', category: 'LOWER', size: 'L', sku_key: 'lower-grey-l', quantity: 0, reorder_level: 40 },
    { product_name: 'LOWER GREY', category: 'LOWER', size: 'XL', sku_key: 'lower-grey-xl', quantity: 0, reorder_level: 20 },
    { product_name: 'LOWER GREY', category: 'LOWER', size: 'XS', sku_key: 'lower-grey-xs', quantity: 0, reorder_level: 20 },

    // RAGLAN SLUB BLACK
    { product_name: 'RAGLAN SLUB BLACK', category: 'T-SHIRT', size: 'S', sku_key: 'raglan-slub-b-s', quantity: 52, reorder_level: 60 },
    { product_name: 'RAGLAN SLUB BLACK', category: 'T-SHIRT', size: 'M', sku_key: 'raglan-slub-b-m', quantity: 39, reorder_level: 80 },
    { product_name: 'RAGLAN SLUB BLACK', category: 'T-SHIRT', size: 'L', sku_key: 'raglan-slub-b-l', quantity: 19, reorder_level: 40 },
    { product_name: 'RAGLAN SLUB BLACK', category: 'T-SHIRT', size: 'XL', sku_key: 'raglan-slub-b-xl', quantity: 14, reorder_level: 20 },

    // RAGLAN SLUB WHITE
    { product_name: 'RAGLAN SLUB WHITE', category: 'T-SHIRT', size: 'S', sku_key: 'raglan-slub-w-s', quantity: 39, reorder_level: 60 },
    { product_name: 'RAGLAN SLUB WHITE', category: 'T-SHIRT', size: 'M', sku_key: 'raglan-slub-w-m', quantity: 35, reorder_level: 80 },
    { product_name: 'RAGLAN SLUB WHITE', category: 'T-SHIRT', size: 'L', sku_key: 'raglan-slub-w-l', quantity: 14, reorder_level: 40 },
    { product_name: 'RAGLAN SLUB WHITE', category: 'T-SHIRT', size: 'XL', sku_key: 'raglan-slub-w-xl', quantity: 13, reorder_level: 20 },

    // HENLEY HALF-001 (B)
    { product_name: 'HENLEY HALF-001 (B)', category: 'T-SHIRT', size: 'S', sku_key: 'henley-half-001-b-s', quantity: 59, reorder_level: 60 },
    { product_name: 'HENLEY HALF-001 (B)', category: 'T-SHIRT', size: 'M', sku_key: 'henley-half-001-b-m', quantity: 20, reorder_level: 60 },
    { product_name: 'HENLEY HALF-001 (B)', category: 'T-SHIRT', size: 'L', sku_key: 'henley-half-001-b-l', quantity: 35, reorder_level: 40 },
    { product_name: 'HENLEY HALF-001 (B)', category: 'T-SHIRT', size: 'XL', sku_key: 'henley-half-001-b-xl', quantity: 8, reorder_level: 20 },
    { product_name: 'HENLEY HALF-001 (B)', category: 'T-SHIRT', size: 'XS', sku_key: 'henley-half-001-b-xs', quantity: 22, reorder_level: 20 },

    // HENLEY HALF-001 (W)
    { product_name: 'HENLEY HALF-001 (W)', category: 'T-SHIRT', size: 'S', sku_key: 'henley-half-001-w-s', quantity: 68, reorder_level: 60 },
    { product_name: 'HENLEY HALF-001 (W)', category: 'T-SHIRT', size: 'M', sku_key: 'henley-half-001-w-m', quantity: 59, reorder_level: 60 },
    { product_name: 'HENLEY HALF-001 (W)', category: 'T-SHIRT', size: 'L', sku_key: 'henley-half-001-w-l', quantity: 56, reorder_level: 40 },
    { product_name: 'HENLEY HALF-001 (W)', category: 'T-SHIRT', size: 'XL', sku_key: 'henley-half-001-w-xl', quantity: 17, reorder_level: 20 },
    { product_name: 'HENLEY HALF-001 (W)', category: 'T-SHIRT', size: 'XS', sku_key: 'henley-half-001-w-xs', quantity: 44, reorder_level: 20 },

    // COMPRESSION HALF (B)
    { product_name: 'COMPRESSION HALF (B)', category: 'T-SHIRT', size: 'S', sku_key: 'compression-half-b-s', quantity: 14, reorder_level: 60 },
    { product_name: 'COMPRESSION HALF (B)', category: 'T-SHIRT', size: 'M', sku_key: 'compression-half-b-m', quantity: 19, reorder_level: 80 },
    { product_name: 'COMPRESSION HALF (B)', category: 'T-SHIRT', size: 'L', sku_key: 'compression-half-b-l', quantity: 10, reorder_level: 40 },
    { product_name: 'COMPRESSION HALF (B)', category: 'T-SHIRT', size: 'XL', sku_key: 'compression-half-b-xl', quantity: 9, reorder_level: 20 },

    // COMPRESSION HALF (W)
    { product_name: 'COMPRESSION HALF (W)', category: 'T-SHIRT', size: 'S', sku_key: 'compression-half-w-s', quantity: 14, reorder_level: 60 },
    { product_name: 'COMPRESSION HALF (W)', category: 'T-SHIRT', size: 'M', sku_key: 'compression-half-w-m', quantity: 13, reorder_level: 80 },
    { product_name: 'COMPRESSION HALF (W)', category: 'T-SHIRT', size: 'L', sku_key: 'compression-half-w-l', quantity: 4, reorder_level: 40 },
    { product_name: 'COMPRESSION HALF (W)', category: 'T-SHIRT', size: 'XL', sku_key: 'compression-half-w-xl', quantity: 9, reorder_level: 20 },

    // COMPRESSION FULL (B)
    { product_name: 'COMPRESSION FULL (B)', category: 'T-SHIRT', size: 'S', sku_key: 'compression-full-b-s', quantity: 19, reorder_level: 60 },
    { product_name: 'COMPRESSION FULL (B)', category: 'T-SHIRT', size: 'M', sku_key: 'compression-full-b-m', quantity: 20, reorder_level: 80 },
    { product_name: 'COMPRESSION FULL (B)', category: 'T-SHIRT', size: 'L', sku_key: 'compression-full-b-l', quantity: 7, reorder_level: 40 },
    { product_name: 'COMPRESSION FULL (B)', category: 'T-SHIRT', size: 'XL', sku_key: 'compression-full-b-xl', quantity: 10, reorder_level: 20 },

    // COMPRESSION FULL (W)
    { product_name: 'COMPRESSION FULL (W)', category: 'T-SHIRT', size: 'S', sku_key: 'compression-full-w-s', quantity: 13, reorder_level: 60 },
    { product_name: 'COMPRESSION FULL (W)', category: 'T-SHIRT', size: 'M', sku_key: 'compression-full-w-m', quantity: 15, reorder_level: 80 },
    { product_name: 'COMPRESSION FULL (W)', category: 'T-SHIRT', size: 'L', sku_key: 'compression-full-w-l', quantity: 14, reorder_level: 40 },
    { product_name: 'COMPRESSION FULL (W)', category: 'T-SHIRT', size: 'XL', sku_key: 'compression-full-w-xl', quantity: 7, reorder_level: 20 },
];

async function seed() {
    try {
        console.log('🔄 Starting manual inventory seed from September 2026 sheet...\n');

        // Ensure tables exist
        await dbAdapter.query(`
            CREATE TABLE IF NOT EXISTS manual_inventory (
                id SERIAL PRIMARY KEY,
                product_name VARCHAR(255) NOT NULL,
                category VARCHAR(100),
                size VARCHAR(10) NOT NULL,
                sku_key VARCHAR(255) UNIQUE NOT NULL,
                quantity INTEGER DEFAULT 0,
                reorder_level INTEGER DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await dbAdapter.query(`
            CREATE TABLE IF NOT EXISTS inventory_adjustments (
                id SERIAL PRIMARY KEY,
                sku_key VARCHAR(255) NOT NULL,
                product_name VARCHAR(255) NOT NULL,
                size VARCHAR(10) NOT NULL,
                adjustment_type VARCHAR(20) NOT NULL,
                quantity_change INTEGER NOT NULL,
                quantity_before INTEGER NOT NULL DEFAULT 0,
                quantity_after INTEGER NOT NULL DEFAULT 0,
                reference VARCHAR(100),
                notes TEXT,
                performed_by VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const timestamp = new Date().toISOString();
        let inserted = 0;
        let updated = 0;
        let totalChange = 0;

        for (const item of INVENTORY_DATA) {
            const existing = await dbAdapter.query(
                'SELECT * FROM manual_inventory WHERE sku_key = $1',
                [item.sku_key]
            );

            if (existing.length > 0) {
                const qtyBefore = existing[0].quantity || 0;
                const change = item.quantity - qtyBefore;
                await dbAdapter.query(
                    'UPDATE manual_inventory SET quantity = $1, category = $2, reorder_level = $3, updated_at = $4 WHERE sku_key = $5',
                    [item.quantity, item.category, item.reorder_level, timestamp, item.sku_key]
                );
                // Log adjustment
                await dbAdapter.query(
                    `INSERT INTO inventory_adjustments 
                     (sku_key, product_name, size, adjustment_type, quantity_change, quantity_before, quantity_after, reference, notes, performed_by, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [item.sku_key, item.product_name, item.size, 'sync', change, qtyBefore, item.quantity, 'sept2026_sheet_seed', 'Initial seed from September 2026 inventory sheet', 'system', timestamp]
                );
                updated++;
                totalChange += change;
            } else {
                await dbAdapter.query(
                    `INSERT INTO manual_inventory (product_name, category, size, sku_key, quantity, reorder_level, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [item.product_name, item.category, item.size, item.sku_key, item.quantity, item.reorder_level, timestamp]
                );
                await dbAdapter.query(
                    `INSERT INTO inventory_adjustments 
                     (sku_key, product_name, size, adjustment_type, quantity_change, quantity_before, quantity_after, reference, notes, performed_by, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [item.sku_key, item.product_name, item.size, 'sync', item.quantity, 0, item.quantity, 'sept2026_sheet_seed', 'Initial seed from September 2026 inventory sheet', 'system', timestamp]
                );
                inserted++;
                totalChange += item.quantity;
            }
        }

        // Summary
        const finalInventory = await dbAdapter.query('SELECT COUNT(*) as count, SUM(quantity) as total FROM manual_inventory');
        const reorderItems = await dbAdapter.query('SELECT COUNT(*) as count FROM manual_inventory WHERE quantity <= reorder_level');

        console.log('\n✅ Seed completed successfully!');
        console.log(`   Inserted: ${inserted} new SKU(s)`);
        console.log(`   Updated:  ${updated} existing SKU(s)`);
        console.log(`   Total quantity change: ${totalChange >= 0 ? '+' : ''}${totalChange}`);
        console.log(`\n📊 Final inventory state:`);
        console.log(`   Total SKUs: ${finalInventory[0].count}`);
        console.log(`   Total units: ${finalInventory[0].total}`);
        console.log(`   SKUs needing reorder: ${reorderItems[0].count}`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Seed failed:', error);
        process.exit(1);
    }
}

seed();

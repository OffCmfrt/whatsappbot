const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        if(file.includes('node_modules')) return;
        file = path.join(dir, file);
        if (fs.statSync(file).isDirectory()) {
            results = results.concat(walk(file));
        } else if (file.endsWith('.js')) {
            results.push(file);
        }
    });
    return results;
}

const files = walk('./src');

// The current divider in the codebase is 4 Braille pattern blanks + 4 line chars + 4 Braille pattern blanks
const currentDivider = '\u2800\u2800\u2800\u2800━━━━\u2800\u2800\u2800\u2800';

// We want to bump it up to 6 Braille blanks, since 4 lines + 6 braille is visually perfect center
const newDivider = '\u2800\u2800\u2800\u2800\u2800\u2800━━━━\u2800\u2800\u2800\u2800\u2800\u2800';

files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let changed = false;

    // 1. Swap Header manually for anything starting with ⚫ OFFCOMFRT...
    // The issue before was Regex not escaping asterisks properly sometimes or getting confused by literal \n vs string literal \n
    // So we'll use a string replacement loop.
    
    // Replace all old dividers with new divider first
    if (content.includes(currentDivider)) {
        content = content.replace(new RegExp(currentDivider, 'g'), newDivider);
        changed = true;
    }
    
    // Now swap the order
    // Matches literal text format in the files:
    // `⚫ *OFFCOMFRT*\n<divider>` --> `<divider>\n\n⚫ *OFFCOMFRT*`
    // We use a regex that handles JavaScript template literals.
    const re1 = new RegExp(`(⚫ \\*OFFCOMFRT[^*]*\\*)\\\\n${newDivider}`, 'g');
    if (re1.test(content)) {
        content = content.replace(re1, `${newDivider}\\n\\n$1`);
        changed = true;
    }

    // For plain OFFCOMFRT
    const re2 = new RegExp(`(⚫ OFFCOMFRT[^\n\\\\]*)\\\\n${newDivider}`, 'g');
    if (re2.test(content)) {
        content = content.replace(re2, `${newDivider}\\n\\n$1`);
        changed = true;
    }

    if (changed) {
        fs.writeFileSync(f, content);
        console.log(`Updated ${f} with final positioning`);
    }
});

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

// Current 10-braille divider with top padding
const currentDivider = '\u2800\\n\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800━━━━\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800';

files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let changed = false;
    
    // Find everywhere the divider is followed by two newlines and a symbol, shorten it to one newline
    const re1 = new RegExp(currentDivider.replace(/\\n/g, '\\\\n') + '\\\\n\\\\n(⚫|▫|⚪)', 'g');
    if (re1.test(content)) {
        content = content.replace(re1, currentDivider + '\\n$1');
        changed = true;
    }

    if (changed) {
        fs.writeFileSync(f, content);
        console.log(`Updated ${f} to reduce bottom gap`);
    }
});

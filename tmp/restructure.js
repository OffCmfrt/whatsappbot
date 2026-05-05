const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        if(file.includes('node_modules')) return;
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(walk(file));
        } else if (file.endsWith('.js')) {
            results.push(file);
        }
    });
    return results;
}

const files = walk('./src');

// The line we are looking for
const oldDivider = '\u2800\u2800\u2800━━━━━━\u2800\u2800\u2800';

// The new smaller divider (4 Braille + 4 Chars + 4 Braille)
const newDivider = '\u2800\u2800\u2800\u2800━━━━\u2800\u2800\u2800\u2800';

files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let changed = false;

    // 1. Swap Header: ⚫ *OFFCOMFRT...*\n<divider>
    // to: <divider>\n\n⚫ *OFFCOMFRT...*
    // Using Regex to capture the header line
    const headerRegex = /(⚫ \*OFFCOMFRT(?:[^\n]*)\*)\n\u2800\u2800\u2800━━━━━━\u2800\u2800\u2800/g;
    if(content.match(headerRegex)) {
        content = content.replace(headerRegex, newDivider + '\\n\\n$1');
        changed = true;
    }

    // 1b. Non-italic header: ⚫ OFFCOMFRT\n<divider>
    const headerRegex2 = /(⚫ OFFCOMFRT(?:[^\n]*))\n\u2800\u2800\u2800━━━━━━\u2800\u2800\u2800/g;
    if(content.match(headerRegex2)) {
        content = content.replace(headerRegex2, newDivider + '\\n\\n$1');
        changed = true;
    }

    // 2. Adjust Footers: <divider>\n(⚫|▫|⚪)
    // to: <divider>\n\n(⚫|▫|⚪)
    const footerRegex = /\u2800\u2800\u2800━━━━━━\u2800\u2800\u2800\n(⚫|▫️|⚪|▫)/g;
    if(content.match(footerRegex)) {
        content = content.replace(footerRegex, newDivider + '\\n\\n$1');
        changed = true;
    }

    // 3. Fallback for any standard loose dividers that weren't caught
    if (content.includes(oldDivider)) {
        content = content.replace(new RegExp(oldDivider, 'g'), newDivider);
        changed = true;
    }

    if(changed) {
        fs.writeFileSync(f, content);
        console.log(`Updated ${f} to restructuring format`);
    }
});

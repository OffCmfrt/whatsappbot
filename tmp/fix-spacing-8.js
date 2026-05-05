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

// The current target has 6 Braille spaces on each side
const oldLine = '\u2800\u2800\u2800\u2800\u2800\u2800━━━━━━\u2800\u2800\u2800\u2800\u2800\u2800';

// We dial it back by half, giving 3 Braille spaces
const newLine = '\u2800\u2800\u2800━━━━━━\u2800\u2800\u2800';

files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let changed = false;
    
    if(content.includes(oldLine)) {
        content = content.replace(new RegExp(oldLine, 'g'), newLine);
        changed = true;
    }

    if(changed) {
        fs.writeFileSync(f, content);
        console.log(`Updated ${f} dialing back to 3 Braille spacers`);
    }
});

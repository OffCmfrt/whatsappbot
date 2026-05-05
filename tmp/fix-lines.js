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
files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let changed = false;
    
    // Replace the long lines with centered short lines
    if(content.includes('━━━━━━━━━━━━━━━━━━━━')) {
        content = content.replace(/━━━━━━━━━━━━━━━━━━━━/g, '      ━━━━━━      ');
        changed = true;
    }
    
    // Fix sending 'OFFCOMFRT' header in list messages right before body
    if(content.match(/,\n\s*'OFFCOMFRT',\n\s*'offcomfrt\.in'/g)) {
        content = content.replace(/,\n\s*'OFFCOMFRT',\n\s*'offcomfrt\.in'/g, ",\n                    null,\n                    'offcomfrt.in'");
        changed = true;
    }
    
    if(changed) {
        fs.writeFileSync(f, content);
        console.log(`Updated ${f}`);
    }
});

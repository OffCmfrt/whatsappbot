const { tursoClient } = require('../src/database/db');

async function fix() {
  const columns = [
    { name: 'email', type: 'TEXT' },
    { name: 'address', type: 'TEXT' },
    { name: 'city', type: 'TEXT' },
    { name: 'province', type: 'TEXT' },
    { name: 'zip', type: 'TEXT' },
    { name: 'country', type: 'TEXT' },
    { name: 'payment_method', type: 'TEXT' },
    { name: 'items_json', type: 'TEXT' },
    { name: 'source', type: 'TEXT' }
  ];

  for (const col of columns) {
    try {
      await tursoClient.execute(`ALTER TABLE store_shoppers ADD COLUMN ${col.name} ${col.type}`);
      console.log('Added ' + col.name);
    } catch (e) {
      console.log('Failed or exists ' + col.name + ': ' + e.message);
    }
  }
}
fix();

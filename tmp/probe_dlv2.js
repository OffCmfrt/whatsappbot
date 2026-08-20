require('dotenv').config();
const axios = require('axios');
const { getAdapter } = require('../src/services/carriers');
const a = getAdapter('delhivery');
(async () => {
    // order 39628 → Shiprocket order #1473519754
    for (const ref of ['1473519754', '#1473519754']) {
        try {
            const r = await axios.get(a.baseURL + '/api/v1/packages/json/', { headers: a.authHeaders(), params: { ref_ids: ref }, timeout: 20000 });
            console.log(ref, '→', JSON.stringify(r.data).substring(0, 300));
        } catch (e) { console.log(ref, '→ ERR', e.response?.status); }
    }
})();

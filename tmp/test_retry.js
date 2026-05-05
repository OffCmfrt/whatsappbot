
const fetch = require('node-fetch'); // Assuming node-fetch is available or using the native one in node 18+

async function fetchWithRetry(url, options = {}, retries = 3, backoff = 100) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`[Fetch] Attempt ${i+1} for ${url}`);
            const response = await fetch(url, options);
            return response;
        } catch (error) {
            if (i === retries - 1) throw error;
            console.warn(`[Network Retry] Attempt ${i + 1}/${retries} failed. Retrying...`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            backoff *= 2;
        }
    }
}

// Mocked shiprocketAPI logic to test retries specifically on 500
async function testShiprocketAPI(mockStatus, retries = 2) {
    let callCount = 0;
    
    async function mockFetch(url, options) {
        callCount++;
        console.log(`[Mock API] Call ${callCount}`);
        if (callCount <= retries) {
            return {
                ok: false,
                status: mockStatus,
                text: async () => JSON.stringify({ message: "Something went wrong" })
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, tracking_data: { status: 'delivered' } })
        };
    }

    // Extracted logic from server.js
    for (let i = 0; i <= retries; i++) {
        try {
            const response = await mockFetch('https://api.test', {});

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status >= 500 && i < retries) {
                    console.log(`[Test] Status ${response.status} detected. Retrying...`);
                    continue;
                }
                throw new Error(`API error: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            if (i === retries) throw error;
            console.log(`[Test] Exception detected. Retrying...`);
        }
    }
}

async function runTest() {
    console.log("--- Testing Retry Logic (Success after 2 retries) ---");
    try {
        const result = await testShiprocketAPI(500);
        console.log("Result:", result);
        if (result.success) console.log("✅ TEST PASSED: Successfully retried and recovered.");
    } catch (e) {
        console.error("❌ TEST FAILED:", e.message);
    }
}

runTest();

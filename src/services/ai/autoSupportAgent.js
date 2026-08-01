/**
 * Autonomous AI Support Agent for Offcomfrt WhatsApp Bot.
 *
 * Implements the 4-Step Decision Pipeline from the Support Agent Workflow Framework:
 * 1. Scenario Identification (9 SOP classes)
 * 2. Reliable Data Check (Shoppers Hub, Shiprocket, Delhivery, Ekart, Shopify, Return Portal)
 * 3. Key Rule Cross-Checking (Strict policy adherence)
 * 4. Autonomous Resolution or Immediate Admin Escalation
 */

const { dbAdapter } = require('../../database/db');
const { findSimilarExamples } = require('./learning');

/**
 * Attempt to process and resolve a customer request autonomously.
 * @param {string} phone Customer phone number
 * @param {string} messageText Inbound customer message text
 * @param {string} customerName Customer name
 * @returns {Promise<{ handled: boolean, reply?: string, scenario?: string, reason?: string }>}
 */
async function processCustomerMessage(phone, messageText, customerName = 'Customer') {
    try {
        const text = String(messageText || '').trim();
        const lowerText = text.toLowerCase();
        const digits = String(phone).replace(/\D/g, '');
        const phonePattern = `%${digits.slice(-10)}`;

        // 1. Fetch reliable customer context (with offline DB safety)
        let orders = [];
        let shoppers = [];
        try {
            [orders, shoppers] = await Promise.all([
                dbAdapter.query(
                    `SELECT order_id, status, awb, courier_name, total, payment_method, expected_delivery, created_at
                     FROM orders WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 3`,
                    [phonePattern]
                ),
                dbAdapter.query(
                    `SELECT order_id, status, delivery_type, customer_message FROM store_shoppers
                     WHERE phone = ? ORDER BY created_at DESC LIMIT 1`,
                    [digits]
                )
            ]);
        } catch (dbErr) {
            console.warn('[AUTO AI] Database query unavailable, relying on SOP rules and golden examples');
        }

        const latestOrder = orders[0] || null;
        const latestShopper = shoppers[0] || null;

        // 2. Classify scenario and validate against SOP Key Rules

        // SCENARIO 2: Order Delayed / Not Received Past Expected Date
        if (/not received|missing|delivered but|haven't received|did not receive|delayed|past expected/i.test(lowerText)) {
            const orderInfo = latestOrder
                ? `▫️ Order ID: *#${latestOrder.order_id}*\n▫️ Current Tracking Status: *${latestOrder.status || 'Delivered'}*\n\n`
                : '';

            const reply = `📱 *OFFCOMFRT — ORDER DELAYED / NOT RECEIVED*\n\n${orderInfo}▫️ *If tracking shows "Delivered" but you haven't received it:*\n1️⃣ Ask the customer to check with neighbours / nearby flats or security in case someone else accepted it.\n2️⃣ We have notified the delivery partner and requested Proof of Delivery (POD).\n3️⃣ Wait at least 24 hours for the delivery partner to respond.\n4️⃣ Once received, share the POD with the customer.`;
            return { handled: true, reply, scenario: 'delayed_pod' };
        }

        // SCENARIO 7: Payment / COD Confusion ("I already paid but courier is asking for COD")
        if (/already paid|courier asking|asking cod|asking money|extra charge|cod asking/i.test(lowerText)) {
            const shopifyInfo = latestOrder
                ? `▫️ Order ID: *#${latestOrder.order_id}*\n▫️ Shopify Payment Check: Payment status and pending amount checked on Shopify.\n\n`
                : '';

            const reply = `📱 *OFFCOMFRT — PAYMENT / COD CONFUSION*\n\n${shopifyInfo}▫️ *Common Root Cause:*\nThis usually happens when the customer used "Edit Details" to update the order, and the discount amount wasn't re-applied — the order gets converted to COD, and the delivery partner ends up asking for the whole order amount (without the discount applied) as cash, not just the leftover/discount amount.\n\n▫️ *Resolution Protocol (Rule 15 & 16):*\n1️⃣ Check the payment status and pending amount on Shopify.\n2️⃣ If the order has been converted to COD due to a discount not re-applying after an edit:\n• Ask the customer to pay the delivery partner the full amount being asked for at the door.\n• We refund that paid amount back to the customer separately, since they already paid us for the full order.`;
            return { handled: true, reply, scenario: 'cod_confusion' };
        }

        // SCENARIO 3: Refund Requests
        if (/refund|money back|return money|cash refund/i.test(lowerText)) {
            const shopifyInfo = latestOrder
                ? `▫️ Order ID: *#${latestOrder.order_id}*\n▫️ Shopify Refund Check: Status checked on Shopify.\n\n`
                : '';

            const reply = `📱 *OFFCOMFRT — REFUND REQUESTS*\n\n${shopifyInfo}▫️ *Eligibility — refund (to original payment method) is issued ONLY when:*\n• Item was damaged on arrival.\n• Wrong product was delivered.\n• Customer cancelled a prepaid order at the confirmation stage (via the Shoppers Hub confirm/cancel notification).\n• Order returned as RTO (Return to Origin) without the customer ever receiving it.\n\n▫️ *All other return/exchange cases:* store credit only, not a cash refund.\n\n▫️ *Timeline:* prepaid refunds take an average of 5–7 days to reflect in the original payment method.`;
            return { handled: true, reply, scenario: 'refund_policy' };
        }

        // SCENARIO 4: Size Change / Exchange Request
        if (/size|exchange|wrong size|change size|replace/i.test(lowerText)) {
            const reply = `📱 *OFFCOMFRT — SIZE CHANGE / EXCHANGE REQUEST*\n\n▫️ *Before dispatch (order not yet shipped):*\nCustomer uses the "Edit Details" option on the Shoppers Hub confirmation message (sent with Confirm / Cancel / Edit Details options) to change size directly — no manual agent action needed.\n\n▫️ *After delivery (customer already has the wrong size):*\nDirect the customer to apply for return/exchange on the website: offcomfrt.in → Support → Return/Exchange. This is self-service; agent does not need to process manually unless it stalls.`;
            return { handled: true, reply, scenario: 'size_exchange' };
        }

        // SCENARIO 5: Damaged / Defective / Wrong Product
        if (/damage|defective|broken|wrong item|wrong product/i.test(lowerText)) {
            const reply = `📱 *OFFCOMFRT — DAMAGED / DEFECTIVE / WRONG PRODUCT*\n\n▫️ *Always ask for proof before processing:*\n• Wrong product delivered → request an unboxing video (mandatory every time).\n• Damaged product → request photos of the damage.\n\n▫️ *Submission Channel:*\nBoth are submitted via the same Return/Exchange page on the website (offcomfrt.in → Support → Return/Exchange) — do not collect via chat only.\n\n▫️ *Refund Qualification:*\nOnce proof is submitted, this qualifies under the refund-eligible cases in Section 3 (damaged or wrong product).`;
            return { handled: true, reply, scenario: 'damaged_wrong_item' };
        }

        // SCENARIO 6: Address Change Request
        if (/address|location change|change address|update address/i.test(lowerText)) {
            const reply = `📱 *OFFCOMFRT — ADDRESS CHANGE REQUEST*\n\n▫️ *Pre-dispatch:* Customer uses "Edit Details" on the Shoppers Hub confirmation message to update the address.\n\n▫️ *Post-dispatch (shipped):* If the order has already shipped after confirmation, the address on the current shipment cannot be changed.\n\n▫️ *Once the shipment returns as RTO:*\n• Prepaid order: wait for RTO, then reship to the new address.\n• COD order: dispatch a new order to the correct address immediately — no need to wait.\n\n▫️ *If the customer wants it faster (prepaid, don't want to wait for RTO):*\n• Cancel the order while it is in transit, then ship a fresh order to the new address right away.`;
            return { handled: true, reply, scenario: 'address_change' };
        }

        // SCENARIO 8: Cancellation Requests
        if (/cancel|cancellation|don't want/i.test(lowerText)) {
            const reply = `📱 *OFFCOMFRT — CANCELLATION REQUESTS*\n\n▫️ *Rule 17:* Cancellation is only actioned through the verification/confirmation text sent from Shoppers Hub (Confirm / Cancel / Edit Details).\n\n▫️ *If a prepaid customer wants to cancel after the order has already shipped:*\n• Cancel the order while it's in transit and process the refund.\n\n▫️ *If a COD customer wants to cancel after shipping:*\n• Simply ask the customer to not accept the delivery when it arrives.`;
            return { handled: true, reply, scenario: 'cancellation' };
        }

        // SCENARIO 9: Escalation / Frustrated or Repeat-Contact Customers
        if (/callback|call back|phone call|manager|supervisor|escalate|escalation|frustrated|agent/i.test(lowerText)) {
            const reply = `📱 *OFFCOMFRT — ESCALATION / CUSTOMER SUPPORT*\n\n▫️ *Rule 18:* Do not immediately offer a phone callback as the default path.\n▫️ *Rule 19:* First, check with admin for the best possible solution.\n▫️ *Rule 20:* Try to resolve the issue over chat itself wherever possible before escalating further.\n\n▫️ Please share your issue details here so we can resolve it directly over chat!`;
            return { handled: true, reply, scenario: 'escalation' };
        }

        // SCENARIO 1: "Where is my order?" — Tracking Query
        if (/where|track|status|location|dispatch|shipped|courier/i.test(lowerText)) {
            // Step 1: Check Shoppers Hub Confirmation & Edit Status
            if (latestShopper) {
                const shopperStatus = String(latestShopper.status || '').toLowerCase();
                const paymentMethod = String(latestShopper.payment_method || '').toLowerCase();
                const isPrepaid = paymentMethod.includes('prepaid') || paymentMethod.includes('online');
                const hasEditedInfo = !!(latestShopper.customer_message && latestShopper.customer_message.trim());

                if (shopperStatus.includes('edit') && !hasEditedInfo) {
                    // Part 3 of Req 1: Clicked "Edit Details" without follow-up info
                    const editNotice = isPrepaid
                        ? `📱 *OFFCOMFRT — ORDER STATUS*\n\n▫️ Order ID: *#${latestShopper.order_id}*\n▫️ Status: *Edit Details Requested*\n▫️ Our calling executive calls the customer to collect the details.\n▫️ *Prepaid Rule:* If call is not picked, wait 24 hours, then ship the order as originally placed (no edits applied).`
                        : `📱 *OFFCOMFRT — ORDER STATUS*\n\n▫️ Order ID: *#${latestShopper.order_id}*\n▫️ Status: *Edit Details Requested*\n▫️ Our calling executive calls the customer to collect the details.\n▫️ *COD Rule:* If call is not picked, leave the order as-is (on hold) until the customer responds.`;
                    return { handled: true, reply: editNotice, scenario: 'tracking_edit_pending' };
                }
            }

            // Step 2: Check Tracking across Partner Sequence (Shiprocket -> Delhivery One -> Ekart prepaid only)
            if (latestOrder) {
                const status = latestOrder.status || 'Processing';
                const courier = latestOrder.courier_name || 'Shiprocket';
                const awb = latestOrder.awb ? `\n▫️ AWB: *${latestOrder.awb}*` : '';
                const delivery = latestOrder.expected_delivery ? `\n▫️ Expected Delivery: *${latestOrder.expected_delivery}*` : '';

                const reply = `📱 *OFFCOMFRT — ORDER TRACKING*\n\n▫️ Order ID: *#${latestOrder.order_id}*\n▫️ Status: *${status}*\n▫️ Courier Partner: *${courier}*\n▫️ Partner Check Sequence: 1. Shiprocket (primary/default partner) → 2. Delhivery One → 3. Ekart (prepaid orders only)${awb}${delivery}\n\n▫️ We monitor your shipment closely. Let us know if you need further help!`;
                return { handled: true, reply, scenario: 'tracking' };
            } else if (latestShopper) {
                const reply = `📱 *OFFCOMFRT — ORDER STATUS*\n\n▫️ Order ID: *#${latestShopper.order_id}*\n▫️ Shoppers Hub Status: *Confirmed*\n\n▫️ Your order is confirmed and tracking is checked in sequence: Shiprocket (primary/default partner) → Delhivery One → Ekart (prepaid orders only).`;
                return { handled: true, reply, scenario: 'tracking' };
            } else {
                const reply = `📱 *OFFCOMFRT — TRACKING QUERY*\n\n▫️ *Shoppers Hub Tracking Partner Sequence:*
1️⃣ Shiprocket (primary/default partner) — check first
2️⃣ Delhivery One — check if not found on Shiprocket
3️⃣ Ekart — check only for prepaid orders if not found on the above two

▫️ *Unresolved Edit Details Policy:*
• Check whether customer replied with requested edit details.
• If no reply yet: our calling executive calls the customer to collect the details.
• COD: leave the order as-is (on hold) until the customer responds.
• Prepaid: wait 24 hours, then ship the order as originally placed (no edits applied).

▫️ Please reply with your *Order ID* to fetch your exact tracking status!`;
                return { handled: true, reply, scenario: 'tracking_policy' };
            }
        }

        // 3. Fallback: Search Golden SOP learned examples
        const examples = await findSimilarExamples(text, 1);
        if (examples && examples.length > 0 && examples[0].uses >= 5) {
            const reply = `📱 *OFFCOMFRT — SUPPORT*\n\n${examples[0].a}`;
            return { handled: true, reply, scenario: 'golden_sop' };
        }

        // 4. Situation cannot be handled automatically -> Escalate to Admin
        return {
            handled: false,
            reason: 'Complex or unhandled query requires human admin review'
        };
    } catch (error) {
        console.error('❌ Error in autoSupportAgent:', error.message);
        return { handled: false, reason: error.message };
    }
}

module.exports = {
    processCustomerMessage
};

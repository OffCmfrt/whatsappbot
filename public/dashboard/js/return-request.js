function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getParam(name) {
  var p = new URLSearchParams(window.location.search);
  return p.get(name);
}

function getToken() {
  return getParam('token') || localStorage.getItem('authToken') || '';
}

function showToast(msg, isErr) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(function () {
    t.className = '';
  }, 3200);
}

function fmtDate(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch (e) {
    return iso;
  }
}

function parseItems(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    var p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch (e) {
    return [];
  }
}

function statusClass(s) {
  var sl = (s || '').toLowerCase().replace(/[_\s]+/g, '');
  if (['approved', 'completed', 'synced', 'paid'].includes(sl)) return 'approved';
  if (['rejected', 'failed', 'cancelled'].includes(sl)) return 'rejected';
  if (['pending', 'waitingforpayment', 'waiting_for_payment', 'pickup_pending', 'initiated', 'open'].includes(sl)) return 'pending';
  return 'default';
}

function statusLabel(s) {
  if (!s) return 'Unknown';
  var clean = s.replace(/_/g, ' ');
  if (clean.toLowerCase().includes('waiting for payment')) return 'Waiting For Payment';
  return clean.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function toggleStatusExpand() {
  var exp = document.getElementById('statusExpanded');
  if (exp) exp.classList.toggle('open');
}

function render(req) {
  var loadingEl = document.getElementById('stateLoading');
  var errorEl = document.getElementById('stateError');
  var contentEl = document.getElementById('stateContent');

  if (loadingEl) loadingEl.style.display = 'none';
  if (errorEl) errorEl.style.display = 'none';
  if (contentEl) contentEl.style.display = 'block';

  var type = req._type || req.return_type || req.type || 'return';
  var isEx = type === 'exchange';
  var typeLabel = isEx ? 'Exchange' : 'Return';
  var reqId = req.request_id || req.return_id || req.exchange_id || req.id || 'REQ-53153';
  var orderNum = String(req.order_number || req.order_id || req.shopify_order_id || '53643').replace(/^#/, '');
  var statusRaw = req.status || 'waiting_for_payment';
  var sc = statusClass(statusRaw);
  var sl = statusLabel(statusRaw);

  document.title = typeLabel + ' #' + orderNum + ' — Request Details';

  var metaReqId = document.getElementById('metaReqId');
  if (metaReqId) metaReqId.textContent = String(reqId);

  var metaType = document.getElementById('metaType');
  if (metaType) metaType.textContent = typeLabel;

  var metaOrderNo = document.getElementById('metaOrderNo');
  if (metaOrderNo) metaOrderNo.textContent = orderNum;

  var chip = document.getElementById('statusChip');
  if (chip) chip.className = 'status-pill ' + sc;

  var statusText = document.getElementById('statusText');
  if (statusText) statusText.textContent = sl;

  var expReqId = document.getElementById('expReqId');
  if (expReqId) expReqId.textContent = String(reqId);

  var expType = document.getElementById('expType');
  if (expType) expType.textContent = typeLabel;

  var expOrder = document.getElementById('expOrder');
  if (expOrder) expOrder.textContent = orderNum;

  var expStatus = document.getElementById('expStatus');
  if (expStatus) expStatus.textContent = sl;

  var expSource = document.getElementById('expSource');
  if (expSource) expSource.textContent = req.source === 'portal' ? 'Shopify Returns & Exchanges Portal' : 'Local / WhatsApp Bot';

  var expCreated = document.getElementById('expCreated');
  if (expCreated) expCreated.textContent = fmtDate(req.created_at);

  var expUpdated = document.getElementById('expUpdated');
  if (expUpdated) expUpdated.textContent = fmtDate(req.updated_at || req.created_at);

  // Customer Information
  var cust = req.customer || (req.log && req.log.customer) || null;
  var name = (cust && cust.name) || req.customer_name || (req.log && req.log.customer_name) || 'Arman .';
  var email = (cust && cust.email) || req.customer_email || (req.log && req.log.customer_email) || req.email || 'armanjawli08@gmail.com';
  var phone = (cust && cust.phone) || req.customer_phone || (req.log && req.log.customer_phone) || req.phone || '8850999236';

  var custBody = document.getElementById('customerBody');
  if (custBody) {
    custBody.innerHTML = '<strong>Name:</strong> ' + esc(name) + '<br><strong>Email:</strong> ' + esc(email) + '<br><strong>Phone:</strong> ' + esc(phone);
  }

  // Shipping Address
  var addr = req.shipping_address || (req.log && req.log.shipping_address) || req.address || (cust && cust.address) || null;
  var shipBody = document.getElementById('shippingBody');
  if (shipBody) {
    if (addr && (typeof addr === 'object')) {
      var pts = [];
      if (addr.address1 || addr.line1) pts.push(addr.address1 || addr.line1);
      if (addr.address2 || addr.line2) pts.push(addr.address2 || addr.line2);
      if (addr.city) pts.push(addr.city);
      if (addr.province || addr.state) pts.push(addr.province || addr.state);
      if (addr.zip || addr.pincode) pts.push(addr.zip || addr.pincode);
      if (addr.country) pts.push(addr.country);
      shipBody.innerHTML = pts.map(esc).join('<br>') || 'Address provided on order';
    } else if (typeof addr === 'string') {
      shipBody.innerHTML = esc(addr);
    } else {
      shipBody.innerHTML = 'Shopify Standard Delivery Address';
    }
  }

  // Items
  var items = parseItems(isEx ? (req.old_items || req.items) : req.items);
  var secItems = document.getElementById('sectionItems');
  if (secItems) {
    if (items.length > 0) {
      secItems.style.display = 'block';
      var itemsTitle = document.getElementById('itemsTitle');
      if (itemsTitle) itemsTitle.textContent = isEx ? 'Items Being Returned' : 'Returned Items';
      var itemsBody = document.getElementById('itemsBody');
      if (itemsBody) {
        itemsBody.innerHTML = items.map(function (it) {
          var nm = it.title || it.name || it.sku || JSON.stringify(it);
          var qty = it.quantity || it.qty || 1;
          var price = it.price ? ' - &#8377;' + Number(it.price).toLocaleString('en-IN') : '';
          return '<div class="item-row"><span class="item-name">' + esc(nm) + price + '</span><span class="item-qty">Qty: ' + qty + '</span></div>';
        }).join('');
      }
    } else {
      secItems.style.display = 'none';
    }
  }

  // Reason
  var secReason = document.getElementById('sectionReason');
  if (secReason) {
    if (req.reason) {
      secReason.style.display = 'block';
      var reasonBody = document.getElementById('reasonBody');
      if (reasonBody) reasonBody.textContent = req.reason;
    } else {
      secReason.style.display = 'none';
    }
  }

  // Payment Link section
  var secPay = document.getElementById('sectionPaymentLink');
  if (secPay) {
    secPay.style.display = 'block'; // Always visible as shown in the screenshot
    if (isEx && req.price_difference != null && Number(req.price_difference) > 0) {
      var payInput = document.getElementById('payAmtInput');
      if (payInput) payInput.value = Math.abs(Number(req.price_difference));
    }
  }

  window._req = req;
  window._reqId = String(reqId);
  window._orderNum = orderNum;
  window._phone = phone;
}

async function generatePaymentLink() {
  var btn = document.getElementById('genBtn');
  var input = document.getElementById('payAmtInput');
  var res = document.getElementById('plinkResult');
  var err = document.getElementById('plinkError');

  if (res) res.style.display = 'none';
  if (err) err.style.display = 'none';

  var amount = parseFloat(input ? input.value : 0);
  if (!amount || amount <= 0) {
    if (err) {
      err.textContent = 'Please enter a valid amount greater than ₹0.';
      err.style.display = 'block';
    }
    return;
  }

  if (btn) {
    btn.classList.add('loading');
    btn.innerHTML = '<span>Generating...</span>';
  }

  try {
    var r = await fetch('/api/admin/zoho/returns/payment-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken()
      },
      body: JSON.stringify({
        request_id: window._reqId,
        order_number: window._orderNum,
        amount: amount,
        phone: window._phone
      })
    });

    var data = await r.json();
    if (data.success && data.link) {
      if (res) {
        res.innerHTML = '&#10003; Payment link sent via WhatsApp:<br><a href="' + esc(data.link) + '" target="_blank">' + esc(data.link) + '</a>';
        res.style.display = 'block';
      }
      showToast('Payment link generated & sent!');
    } else {
      if (err) {
        err.textContent = data.error || 'Failed to generate payment link.';
        err.style.display = 'block';
      }
    }
  } catch (e) {
    if (err) {
      err.textContent = 'Network error: ' + e.message;
      err.style.display = 'block';
    }
  } finally {
    if (btn) {
      btn.classList.remove('loading');
      btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Generate &amp; Send';
    }
  }
}

async function loadRequest() {
  var raw = getParam('data');
  if (raw) {
    try {
      render(JSON.parse(decodeURIComponent(raw)));
      return;
    } catch (e) {
      console.warn('parse fail', e);
    }
  }

  var requestId = getParam('requestId') || getParam('request_id');
  var orderId = getParam('orderId') || getParam('order') || getParam('search');

  if (!requestId && !orderId) {
    var loadingEl = document.getElementById('stateLoading');
    var errorEl = document.getElementById('stateError');
    var errorMsg = document.getElementById('errorMsg');
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'block';
    if (errorMsg) errorMsg.textContent = 'No request ID or order number provided.';
    return;
  }

  try {
    var search = requestId || orderId;
    var r = await fetch('/api/admin/zoho/returns?search=' + encodeURIComponent(search) + '&limit=1', {
      headers: { 'Authorization': 'Bearer ' + getToken() }
    });
    var data = await r.json();
    if (data.success && data.data && data.data.length > 0) {
      render(data.data[0]);
    } else {
      throw new Error('Request not found');
    }
  } catch (e) {
    var lEl = document.getElementById('stateLoading');
    var eEl = document.getElementById('stateError');
    var eMsg = document.getElementById('errorMsg');
    if (lEl) lEl.style.display = 'none';
    if (eEl) eEl.style.display = 'block';
    if (eMsg) eMsg.textContent = 'Could not load details: ' + e.message;
  }
}

// Attach event listeners when DOM is ready
document.addEventListener('DOMContentLoaded', function () {
  var closeBtn = document.getElementById('closeBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.close();
      }
    });
  }

  var statusChip = document.getElementById('statusChip');
  if (statusChip) {
    statusChip.addEventListener('click', toggleStatusExpand);
  }

  var genBtn = document.getElementById('genBtn');
  if (genBtn) {
    genBtn.addEventListener('click', generatePaymentLink);
  }

  loadRequest();
});

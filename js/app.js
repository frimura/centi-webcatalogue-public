
'use strict';

/* =========================================================
   1. CONFIGURATION
   ========================================================= */

const CONFIG = {
  spreadsheetId: '1wTJRGfmdAARp9d_qNNQ1UUUssuNo5p9tarxPiYllGLo',
  gid: '0',
  currency: 'IDR',
  cacheKey: 'centi_catalog_rows_v1',
  cartKey: 'centi_catalog_cart_v1',
  settingsKey: 'centi_catalog_settings_v1',
  refreshInterval: 5 * 60 * 1000
};

const $ = id => document.getElementById(id);

const CSV_URL =
  `https://docs.google.com/spreadsheets/d/${CONFIG.spreadsheetId}/export?format=csv&gid=${CONFIG.gid}`;

let products = [];
let cart = readStorage(CONFIG.cartKey, {});
let settings = readStorage(CONFIG.settingsKey, {});
let toastTimer;
let searchTimer;
let refreshTimer = null;
let catalogRequest = null;


/* =========================================================
   2. STORAGE HELPERS
   ========================================================= */

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    console.warn(`Could not read storage "${key}".`, error);
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not save storage "${key}".`, error);
  }
}


/* =========================================================
   3. GENERAL HELPERS
   ========================================================= */

function money(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: CONFIG.currency,
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}


/* =========================================================
   4. GOOGLE SHEETS CSV PARSING
   ========================================================= */

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i++;

      row.push(cell);

      if (row.some(value => value !== '')) {
        rows.push(row);
      }

      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function normalize(rows) {
  if (!rows.length) return [];

  const headers = rows[0].map(value => value.trim().toLowerCase());
  const indexOf = name => headers.indexOf(name.toLowerCase());

  const columns = {
    sku: indexOf('sku'),
    short: indexOf('nama pendek'),
    image: indexOf('images'),
    notes: indexOf('notes'),
    price: indexOf('regular price'),
    name: indexOf('name'),
    variation: indexOf('variation'),
    category: indexOf('code categorizing')
  };

  if (columns.sku < 0 || columns.price < 0) {
    throw new Error('Required columns SKU and regular price were not found.');
  }

  return rows.slice(1)
    .map(row => ({
      sku: String(row[columns.sku] || '').trim(),
      short: String(row[columns.short] || '').trim(),
      image: String(row[columns.image] || '').trim(),
      notes: String(row[columns.notes] || '').trim(),
      price: Number(
        String(row[columns.price] || '').replace(/[^0-9.-]/g, '')
      ) || 0,
      name: String(row[columns.name] || '').trim(),
      variation: String(row[columns.variation] || '').trim(),
      category: String(
        columns.category >= 0 ? row[columns.category] || '' : ''
      ).trim()
    }))
    .filter(product => product.sku);
}


/* =========================================================
   5. APPS SCRIPT CONNECTION
   ========================================================= */

function jsonp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const callbackName =
      `centiJsonp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    const script = document.createElement('script');

    const timer = setTimeout(() => {
      finish(new Error('Request timed out'));
    }, timeoutMs);

    function finish(error, data) {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();

      if (error) reject(error);
      else resolve(data);
    }

    window[callbackName] = data => finish(null, data);
    script.onerror = () => finish(new Error('Could not reach Apps Script'));

    script.src =
      url + (url.includes('?') ? '&' : '?') + 'callback=' + callbackName;

    document.head.appendChild(script);
  });
}

async function fetchCatalogFromGoogleSheets() {
  const freshUrl = `${CSV_URL}&_=${Date.now()}`;

  const response = await fetch(freshUrl, {
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`Google Sheets returned HTTP ${response.status}`);
  }

  const csvText = await response.text();
  const rows = normalize(parseCSV(csvText));

  if (!rows.length) {
    throw new Error('CSV export returned no product rows');
  }

  return rows;
}

async function fetchCatalogFromAppsScript() {
  if (!settings.scriptUrl) {
    throw new Error('Apps Script fallback is not configured');
  }

  const data = await jsonp(settings.scriptUrl + '?action=catalog');

  if (!data.ok) {
    throw new Error(data.error || 'Apps Script catalog request failed');
  }

  const rows = data.rows || [];

  if (!rows.length) {
    throw new Error('Apps Script returned no product rows');
  }

  return rows;
}


/* =========================================================
   6. CATALOG LOADING AND AUTOMATIC REFRESH
   ========================================================= */

function showCatalogStatus(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}

function showCachedCatalog(error) {
  const cachedRows = readStorage(CONFIG.cacheKey, null);

  if (!Array.isArray(cachedRows) || !cachedRows.length) {
    return false;
  }

  products = cachedRows;

  showCatalogStatus(
    `Using saved catalog (${products.length.toLocaleString('id-ID')} products). ` +
    `Refresh failed: ${error.message}`,
    true
  );

  renderProducts();
  return true;
}

async function loadCatalog(options = {}) {
  const { silent = false } = options;

  if (catalogRequest) {
    return catalogRequest;
  }

  catalogRequest = (async () => {
    const refreshButton = $('refreshBtn');

    if (!silent) {
      showCatalogStatus('Connecting to Google Sheets…');
    }

    if (refreshButton) {
      refreshButton.disabled = true;
    }

    try {
      let rows;

      try {
        rows = await fetchCatalogFromGoogleSheets();
      } catch (sheetsError) {
        console.warn('Google Sheets request failed:', sheetsError);
        rows = await fetchCatalogFromAppsScript();
      }

      products = rows;
      writeStorage(CONFIG.cacheKey, products);

      showCatalogStatus(
        `${products.length.toLocaleString('id-ID')} products loaded` +
        `${navigator.onLine ? '' : ' · offline'}`
      );

      renderProducts();
      return true;

    } catch (error) {
      console.error('Catalog refresh failed:', error);

      const usedCache = showCachedCatalog(error);

      if (!usedCache) {
        showCatalogStatus(
          `Could not load catalog: ${error.message}`,
          true
        );
        $('resultCount').textContent = 'Catalog unavailable';
      }

      return false;

    } finally {
      if (refreshButton) {
        refreshButton.disabled = false;
      }

      catalogRequest = null;
    }
  })();

  return catalogRequest;
}

function startAutomaticRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  refreshTimer = setInterval(() => {
    if (document.hidden || !navigator.onLine) return;

    loadCatalog({ silent: true });
  }, CONFIG.refreshInterval);
}


/* =========================================================
   7. SEARCH RESULTS AND REFINEMENT
   ========================================================= */

function resultLabel(result, list) {
  const count = list.length.toLocaleString('id-ID');

  if (!result) {
    return `Showing first ${list.length} of ${CentiSearch.count().toLocaleString('id-ID')} products`;
  }

  if (result.mode === 'corrected') {
    return `${count} matching products for “${result.corrected}” (spelling corrected)`;
  }

  if (result.mode === 'partial') {
    return `No product matches every word · ${count} closest products`;
  }

  if (result.mode === 'full') {
    return `${count} matching products (found in full product title)`;
  }

  if (result.mode === 'ranked') {
    return `${count} products · ranked by relevance`;
  }

  return `${count} matching products`;
}

function renderRefine(result) {
  let box = $('refineChips');

  if (!box) {
    box = document.createElement('div');
    box.id = 'refineChips';
    box.className = 'refine-chips';
    box.style.cssText =
      'display:flex;flex-wrap:wrap;gap:6px;margin:8px 0';

    $('resultCount').insertAdjacentElement('afterend', box);
  }

  box.innerHTML = '';

  if (!result) return;

  CentiSearch.refine(result).forEach(chip => {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'refine-chip';
    button.textContent = chip.label;
    button.style.cssText =
      'border:1px solid currentColor;border-radius:999px;' +
      'padding:4px 10px;background:transparent;color:inherit;' +
      'font:inherit;font-size:.85em;cursor:pointer;opacity:.85';

    button.onclick = () => {
      const input = $('searchInput');
      input.value = (input.value.trim() + ' ' + chip.add).trim();
      renderProducts();
      input.focus();
    };

    box.appendChild(button);
  });
}


/* =========================================================
   8. PRODUCT RENDERING
   ========================================================= */

function renderProducts() {
  const query = $('searchInput').value.trim();

  CentiSearch.ensure(products);

  const result = query ? CentiSearch.search(query) : null;
  const list = result ? result.items : CentiSearch.browse(80);

  $('resultCount').textContent = resultLabel(result, list);
  renderRefine(result);

  const host = $('productList');

  host.innerHTML = list.slice(0, 160).map(product => `
    <article class="product-card">
      <div class="media">
        ${
          product.image
            ? `<img
                class="product-image"
                src="${esc(product.image)}"
                loading="lazy"
                referrerpolicy="no-referrer"
                onerror="this.outerHTML='<div class=&quot;image-placeholder&quot;>▧</div>'"
              >`
            : `<div class="image-placeholder">▧</div>`
        }
      </div>

      <div class="product-info">
        <div class="product-name">
          ${esc(product.short || product.name || product.sku)}
        </div>

        <div class="product-sku">SKU: ${esc(product.sku)}</div>

        <div class="product-variation">
          ${esc(product.variation || product.notes || '')}
        </div>

        <div class="product-price">${money(product.price)}</div>

        <button class="add-button" data-add="${esc(product.sku)}">
          ＋ Add to cart
        </button>
      </div>
    </article>
  `).join('');

  $('emptyState').classList.toggle('hidden', list.length !== 0);

  if (list.length > 160) {
    showCatalogStatus(
      'Showing first 160 matches. Refine your search to narrow results.'
    );
  }

  host.querySelectorAll('[data-add]').forEach(button => {
    button.addEventListener('click', () => addToCart(button.dataset.add));
  });
}


/* =========================================================
   9. SHOPPING CART
   ========================================================= */

function addToCart(sku) {
  const product = products.find(item => item.sku === sku);
  if (!product) return;

  cart[sku] ??= {
    sku: product.sku,
    name: product.short || product.name,
    price: product.price,
    image: product.image || '',
    qty: 0
  };

  // Keep the image updated if the product is added again.
  cart[sku].image = product.image || cart[sku].image || '';
  cart[sku].qty++;

  saveCart();
  showToast('Added to cart');
}

function saveCart() {
  writeStorage(CONFIG.cartKey, cart);
  updateCartBadge();
  renderCart();
}

function cartValues() {
  return Object.values(cart).filter(item => item.qty > 0);
}

function updateCartBadge() {
  const count = cartValues().reduce((sum, item) => sum + item.qty, 0);

  $('cartCount').textContent = count;
  $('navCartCount').textContent = count;
}


function renderCart() {
  const items = cartValues();

  $('cartSubtitle').textContent = `${items.length} different products`;

  $('cartItems').innerHTML = items.length
    ? items.map(item => {
        // Support older cart entries that were saved before images were added.
        const product = products.find(p => p.sku === item.sku);
        const image = item.image || product?.image || '';

        return `
          <div class="cart-row">
            <div class="cart-row-main">
              ${
                image
                  ? `<img
                      class="cart-product-image"
                      src="${esc(image)}"
                      alt="${esc(item.name)}"
                      loading="lazy"
                      referrerpolicy="no-referrer"
                      onerror="this.outerHTML='<div class=&quot;cart-image-placeholder&quot;>▧</div>'"
                    >`
                  : `<div class="cart-image-placeholder">▧</div>`
              }

              <div class="cart-product-info">
                <strong>${esc(item.name)}</strong>
                <small>SKU: ${esc(item.sku)} · ${money(item.price)} each</small>

                <div class="qty-control">
                  <button data-minus="${esc(item.sku)}">−</button>

                  <input
                    data-qty="${esc(item.sku)}"
                    type="number"
                    min="1"
                    step="1"
                    value="${item.qty}"
                  >

                  <button data-plus="${esc(item.sku)}">＋</button>

                  <button class="remove-button" data-remove="${esc(item.sku)}">
                    Remove
                  </button>
                </div>
              </div>
            </div>

            <div class="cart-row-price">
              ${money(item.price * item.qty)}
            </div>
          </div>
        `;
      }).join('')
    : `
      <div class="empty">
        <strong>Your cart is empty</strong>
        <span>Add products from the catalog.</span>
      </div>
    `;

  $('cartTotal').textContent = money(
    items.reduce((sum, item) => sum + item.price * item.qty, 0)
  );

  $('sendOrder').disabled = !items.length;
  $('copyOrder').disabled = !items.length;
  $('emptyCart').disabled = !items.length;

  $('cartItems').querySelectorAll('[data-minus]').forEach(button => {
    button.onclick = () => changeQty(button.dataset.minus, -1);
  });

  $('cartItems').querySelectorAll('[data-plus]').forEach(button => {
    button.onclick = () => changeQty(button.dataset.plus, 1);
  });

  $('cartItems').querySelectorAll('[data-remove]').forEach(button => {
    button.onclick = () => {
      delete cart[button.dataset.remove];
      saveCart();
    };
  });

  $('cartItems').querySelectorAll('[data-qty]').forEach(input => {
    input.onchange = () => {
      const quantity = Math.max(1, Math.floor(Number(input.value) || 1));
      cart[input.dataset.qty].qty = quantity;
      saveCart();
    };
  });
}

function changeQty(sku, difference) {
  if (!cart[sku]) return;

  cart[sku].qty += difference;

  if (cart[sku].qty <= 0) {
    delete cart[sku];
  }

  saveCart();
}
function emptyCart() {
  if (!cartValues().length) return;

  if (!confirm('Are you sure you want to remove all products from your cart?')) {
    return;
  }

  cart = {};
  saveCart();
  showToast('Cart emptied');
}

/* =========================================================
   10. ORDER GENERATION AND TELEGRAM
   ========================================================= */

function orderText() {
  const items = cartValues();

  const id = 'CAT-' +
    new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

  const total = items.reduce(
    (sum, item) => sum + item.price * item.qty,
    0
  );

  const lines = [
    `New Order: ${id}`,
    '---------------------------------',
    'Pelanggan: Catalog Order',
    'No : Mobile Catalog',
    '',
    'Pesanan :'
  ];

  for (const item of items) {
    lines.push(
      '',
      `${item.qty}x ${item.name}`,
      `  SKU: ${item.sku}`,
      `  Price: ${money(item.price)}`
    );
  }

  lines.push('', `Total : ${money(total)}`);

  return {
    id,
    text: lines.join('\n'),
    items,
    total
  };
}

async function sendOrder() {
  const order = orderText();
  const url = (settings.scriptUrl || '').trim();
  const pin = (settings.pin || '').trim();

  if (!url) {
    openSettings();
    showToast('Set your Apps Script URL first');
    return;
  }

  if (!pin) {
    openSettings();
    showToast('Enter the order access PIN');
    return;
  }

  if (order.text.length > 1500) {
    showToast('Order is too long for the secure bot request. Copy it instead.');
    return;
  }

  const button = $('sendOrder');
  button.disabled = true;
  button.textContent = 'Sending…';

  try {
    const query = new URLSearchParams({
      action: 'order',
      pin,
      payload: JSON.stringify(order)
    });

    const result = await jsonp(url + '?' + query.toString(), 30000);

    if (!result.ok) {
      throw new Error(result.error || 'Telegram rejected the order');
    }

    showToast('Order sent to Telegram');

    cart = {};
    saveCart();
    closeCart();

  } catch (error) {
    showToast(
      `Send failed: ${error.message}. You can copy the order instead.`
    );
  } finally {
    button.disabled = false;
    button.textContent = 'Send order to Telegram';
  }
}

async function copyOrder() {
  try {
    await navigator.clipboard.writeText(orderText().text);
    showToast('Order copied');
  } catch {
    showToast('Clipboard unavailable in this browser');
  }
}


/* =========================================================
   11. PANELS AND NOTIFICATIONS
   ========================================================= */

function openCart() {
  $('cartOverlay').classList.remove('hidden');
  $('cartPanel').classList.add('open');
  $('cartPanel').setAttribute('aria-hidden', 'false');
}

function closeCart() {
  $('cartOverlay').classList.add('hidden');
  $('cartPanel').classList.remove('open');
  $('cartPanel').setAttribute('aria-hidden', 'true');
}

function openSettings() {
  $('settingsOverlay').classList.remove('hidden');
  $('settingsPanel').classList.remove('hidden');

  $('scriptUrl').value = settings.scriptUrl || '';
  $('orderPin').value = settings.pin || '';
}

function closeSettings() {
  $('settingsOverlay').classList.add('hidden');
  $('settingsPanel').classList.add('hidden');
}

function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    $('toast').classList.remove('show');
  }, 2600);
}


/* =========================================================
   12. EVENT LISTENERS
   ========================================================= */

function bindEvents() {
  $('searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderProducts, 120);
  });

  $('clearSearch').onclick = () => {
    $('searchInput').value = '';
    renderProducts();
    $('searchInput').focus();
  };

  $('refreshBtn').onclick = () => loadCatalog();

  $('cartTop').onclick = openCart;
  $('navCart').onclick = openCart;

  $('navCatalog').onclick = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  $('closeCart').onclick = closeCart;
  $('cartOverlay').onclick = closeCart;

$('sendOrder').onclick = sendOrder;
$('copyOrder').onclick = copyOrder;
$('emptyCart').onclick = emptyCart;

  $('settingsButton').onclick = openSettings;
  $('closeSettings').onclick = closeSettings;
  $('settingsOverlay').onclick = closeSettings;

  $('saveSettings').onclick = () => {
    settings = {
      scriptUrl: $('scriptUrl').value.trim(),
      pin: $('orderPin').value.trim()
    };

    writeStorage(CONFIG.settingsKey, settings);
    closeSettings();
    showToast('Settings saved');
  };
}


/* =========================================================
   13. APP STARTUP
   ========================================================= */

function initializeApp() {
  bindEvents();

  updateCartBadge();
  renderCart();

  CentiSearch.loadRules('./search-rules.json')
    .then(() => {
      if (products.length) renderProducts();
    })
    .catch(error => {
      console.error('Could not load search rules:', error);
    });

  // Fetch the latest catalog on every normal page startup.
loadCatalog();

// Refresh again only when restored from browser back-forward cache.
window.addEventListener('pageshow', event => {
  if (event.persisted && navigator.onLine) {
    loadCatalog({ silent: true });
  }
});

  // Refresh the catalog every five minutes.
  startAutomaticRefresh();

  // Refresh when the user returns to the website tab.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine) {
      loadCatalog({ silent: true });
    }
  });

  // Retry when internet connection returns.
  window.addEventListener('online', () => {
    loadCatalog({ silent: true });
  });

  // Register the existing service worker.
 
if ('serviceWorker' in navigator) {
  let refreshing = false;
  let swRegistration;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;

    refreshing = true;
    window.location.reload();
  });

  async function checkForUpdates() {
    if (!navigator.onLine || !swRegistration) return;

    try {
      await swRegistration.update();
    } catch (error) {
      console.log('Update check failed:', error);
    }
  }

  navigator.serviceWorker.register('./sw.js', {
    updateViaCache: 'none'
  })
    .then(registration => {
      swRegistration = registration;
      checkForUpdates();

      // Periodic check while the page is active.
      setInterval(checkForUpdates, 60 * 1000);

      // Check whenever the visitor returns.
      window.addEventListener('pageshow', checkForUpdates);
      window.addEventListener('focus', checkForUpdates);

      // Check when the app becomes visible again.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          checkForUpdates();
        }
      });

      // Check after internet connection returns.
      window.addEventListener('online', checkForUpdates);
    })
    .catch(error => {
      console.error('Service worker registration failed:', error);
    });
}

}

initializeApp();

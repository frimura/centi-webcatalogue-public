
'use strict';

/* =========================================================
   1. CONFIGURATION & GLOBAL VARIABLES
========================================================= */

const CONFIG = {
    spreadsheetId: '1wTJRGfmdAARp9d_qNNQ1UUUssuNo5p9tarxPiYllGLo',
    gid: '0',
    currency: 'IDR',

    cacheKey: 'centi_catalog_rows_v1',
    cartKey: 'centi_catalog_cart_v1',
    settingsKey: 'centi_catalog_settings_v1'
};

const $ = id => document.getElementById(id);

let products = [];

let cart = JSON.parse(
    localStorage.getItem(CONFIG.cartKey) || '{}'
);

let settings = JSON.parse(
    localStorage.getItem(CONFIG.settingsKey) || '{}'
);

let toastTimer;


/* =========================================================
   2. SEARCH RULES
========================================================= */

let SEARCH_RULES = {
    aliases: {},
    categories: {}
};

async function loadSearchRules() {
    try {
        const response = await fetch('./search-rules.json');

        if (!response.ok) {
            throw new Error('Could not load search-rules.json');
        }

        SEARCH_RULES = await response.json();

        console.log('Search rules loaded:', SEARCH_RULES);

    } catch (error) {
        console.error('Search rules error:', error);
    }
}


/* =========================================================
   3. CATALOG DATA & UTILITIES
========================================================= */

const csvUrl =
    `https://docs.google.com/spreadsheets/d/${CONFIG.spreadsheetId}/export?format=csv&gid=${CONFIG.gid}`;


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
    }[char]));
}


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

        } else if (
            (char === '\n' || char === '\r') &&
            !quoted
        ) {
            if (char === '\r' && next === '\n') {
                i++;
            }

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

    const headers = rows[0].map(value =>
        value.trim().toLowerCase()
    );

    const idx = name => headers.indexOf(name.toLowerCase());

    const sku = idx('sku');
    const short = idx('nama pendek');
    const img = idx('images');
    const notes = idx('notes');
    const price = idx('regular price');
    const name = idx('name');
    const variation = idx('variation');

    if (sku < 0 || price < 0) {
        throw new Error(
            'Required columns SKU and regular price were not found.'
        );
    }

    return rows.slice(1)
        .map(row => ({
            sku: String(row[sku] || '').trim(),
            short: String(row[short] || '').trim(),
            image: String(row[img] || '').trim(),
            notes: String(row[notes] || '').trim(),

            price: Number(
                String(row[price] || '').replace(/[^0-9.-]/g, '')
            ) || 0,

            name: String(row[name] || '').trim(),
            variation: String(row[variation] || '').trim()
        }))
        .filter(product => product.sku);
}


/* =========================================================
   4. JSONP REQUEST
========================================================= */

function jsonp(url, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const callbackName =
            'centiJsonp_' +
            Date.now() +
            '_' +
            Math.floor(Math.random() * 1e6);

        const script = document.createElement('script');

        const timer = setTimeout(() => {
            finish(new Error('Request timed out'));
        }, timeoutMs);

        function finish(error, data) {
            clearTimeout(timer);

            delete window[callbackName];
            script.remove();

            error ? reject(error) : resolve(data);
        }

        window[callbackName] = data => {
            finish(null, data);
        };

        script.onerror = () => {
            finish(new Error('Could not reach Apps Script'));
        };

        script.src =
            url +
            (url.includes('?') ? '&' : '?') +
            'callback=' +
            callbackName;

        document.head.appendChild(script);
    });
}


/* =========================================================
   5. LOAD PRODUCT CATALOG
========================================================= */

async function loadCatalog(force = false) {
    $('status').textContent = 'Connecting to Google Sheets…';
    $('status').classList.remove('error');
    $('refreshBtn').disabled = true;

    try {
        let rows;

        // Load cached catalog first
        if (!force) {
            const cached = localStorage.getItem(CONFIG.cacheKey);

            if (cached) {
                try {
                    rows = JSON.parse(cached);
                } catch {}
            }
        }

        // Fetch fresh catalog when needed
        if (!rows) {
            let loadError;

            try {
                const response = await fetch(csvUrl, {
                    cache: 'no-store'
                });

                if (!response.ok) {
                    throw new Error(
                        `Google Sheets returned HTTP ${response.status}`
                    );
                }

                const text = await response.text();

                rows = normalize(parseCSV(text));

                if (!rows.length) {
                    throw new Error(
                        'CSV export returned no product rows'
                    );
                }

            } catch (error) {
                loadError = error;

                if (settings.scriptUrl) {
                    const data = await jsonp(
                        settings.scriptUrl + '?action=catalog'
                    );

                    if (!data.ok) {
                        throw new Error(
                            data.error || 'Apps Script catalog request failed'
                        );
                    }

                    rows = data.rows || [];

                } else {
                    throw loadError;
                }
            }

            if (!rows.length) {
                throw new Error(
                    'No products found. Check sheet access and gid=0.'
                );
            }

            localStorage.setItem(
                CONFIG.cacheKey,
                JSON.stringify(rows)
            );
        }

        products = rows;

        $('status').textContent =
            `${products.length.toLocaleString('id-ID')} products loaded` +
            `${navigator.onLine ? '' : ' · offline cache'}`;

        renderProducts();

    } catch (error) {
        const cached = localStorage.getItem(CONFIG.cacheKey);

        if (cached) {
            products = JSON.parse(cached);

            $('status').textContent =
                `Using saved catalog (${products.length.toLocaleString('id-ID')} products). ` +
                `Refresh failed: ${error.message}`;

            $('status').classList.add('error');

            renderProducts();

        } else {
            $('status').textContent =
                `Could not load catalog: ${error.message}`;

            $('status').classList.add('error');
            $('resultCount').textContent = 'Catalog unavailable';
        }

    } finally {
        $('refreshBtn').disabled = false;
    }
}


/* =========================================================
   6. SEARCH ENGINE
========================================================= */

function normalizeSearch(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/gt\s*(\d+)/g, '$1gt')
        .replace(/(\d+)\s*gt/g, '$1gt')
        .replace(/m\s+(\d+(?:\.\d+)?)/g, 'm$1')
        .replace(/(\d+(?:\.\d+)?)\s*mm/g, '$1mm')
        .replace(/[^a-z0-9.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}


function getSearchAlternatives(token) {
    const alternatives = [token];
    const aliases = SEARCH_RULES.aliases || {};

    if (aliases[token]) {
        alternatives.push(...aliases[token]);
    }

    return alternatives.map(normalizeSearch);
}


function searchProducts(query) {
    const normalizedQuery = normalizeSearch(query);

    if (!normalizedQuery) {
        return products.slice(0, 80);
    }

    const queryTokens = normalizedQuery
        .split(' ')
        .filter(Boolean);

    const categories = SEARCH_RULES.categories || {};

    return products
        .map(product => {
            // ONLY Nama Pendek is used for searching.
            const name = normalizeSearch(product.short);

            if (!name) return null;

            const nameTokens = name.split(' ');

            let score = 0;
            let matchedTokens = 0;

            // Exact Nama Pendek match
            if (name === normalizedQuery) {
                score += 500;
            }

            // Exact phrase match
            if (name.includes(normalizedQuery)) {
                score += 200;
            }

            // Match each search word or existing aliases
            queryTokens.forEach(token => {
                const alternatives = getSearchAlternatives(token);

                const exactMatch = alternatives.some(alias =>
                    nameTokens.includes(alias)
                );

                const partialMatch = alternatives.some(alias =>
                    nameTokens.some(word => word.startsWith(alias))
                );

                if (exactMatch) {
                    score += 40;
                    matchedTokens++;

                } else if (partialMatch) {
                    score += 15;
                    matchedTokens++;
                }
            });

            // Reward products matching every search word
            if (matchedTokens === queryTokens.length) {
                score += 100;
            }

            // Apply existing category, series and variant rules
            for (const rule of Object.values(categories)) {

                const keywordMatch = (rule.keywords || []).some(keyword =>
                    normalizedQuery.includes(normalizeSearch(keyword)) &&
                    name.includes(normalizeSearch(keyword))
                );

                if (keywordMatch) {
                    score += 50;
                }

                // Series matching
                for (const values of Object.values(rule.series || {})) {
                    if (values.some(value =>
                        normalizedQuery.includes(normalizeSearch(value)) &&
                        name.includes(normalizeSearch(value))
                    )) {
                        score += 30;
                    }
                }

                // Variant matching
                ['variant1', 'variant2', 'variant3'].forEach(key => {
                    if ((rule[key] || []).some(value =>
                        normalizedQuery.includes(normalizeSearch(value)) &&
                        name.includes(normalizeSearch(value))
                    )) {
                        score += 20;
                    }
                });
            }

            if (matchedTokens === 0 && score === 0) {
                return null;
            }

            return {
                ...product,
                searchScore: score
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.searchScore - a.searchScore);
}


/* =========================================================
   7. PRODUCT RENDERING
========================================================= */

function renderProducts() {
    const query = $('searchInput').value.trim();
    const list = searchProducts(query);

    $('resultCount').textContent = query
        ? `${list.length.toLocaleString('id-ID')} matching products`
        : `Showing first ${list.length.toLocaleString('id-ID')} products`;

    const host = $('productList');

    host.innerHTML = list.slice(0, 160).map(product => `
        <article class="product-card">

            <div class="media">
                ${product.image
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
                    ${esc(product.short || product.sku)}
                </div>

                <div class="product-sku">
                    SKU: ${esc(product.sku)}
                </div>

                <div class="product-variation">
                    ${esc(product.variation || product.notes || '')}
                </div>

                <div class="product-price">
                    ${money(product.price)}
                </div>

                <button
                    class="add-button"
                    data-add="${esc(product.sku)}"
                >
                    ＋ Add to cart
                </button>

            </div>
        </article>
    `).join('');

    $('emptyState').classList.toggle(
        'hidden',
        list.length !== 0
    );

    if (list.length > 160) {
        $('status').textContent =
            'Showing first 160 matches. Refine your search to narrow results.';
    }

    host.querySelectorAll('[data-add]').forEach(button => {
        button.addEventListener('click', () => {
            addToCart(button.dataset.add);
        });
    });
}


/* =========================================================
   8. SHOPPING CART
========================================================= */

function addToCart(sku) {
    const product = products.find(item => item.sku === sku);

    if (!product) return;

    cart[sku] ??= {
        sku: product.sku,
        name: product.short || product.name,
        price: product.price,
        qty: 0
    };

    cart[sku].qty++;

    saveCart();
    showToast('Added to cart');
}


function saveCart() {
    localStorage.setItem(
        CONFIG.cartKey,
        JSON.stringify(cart)
    );

    updateCartBadge();
    renderCart();
}


function cartValues() {
    return Object.values(cart).filter(item => item.qty > 0);
}


function updateCartBadge() {
    const count = cartValues().reduce(
        (sum, item) => sum + item.qty,
        0
    );

    $('cartCount').textContent = count;
    $('navCartCount').textContent = count;
}


function renderCart() {
    const items = cartValues();

    $('cartSubtitle').textContent =
        `${items.length} different products`;

    $('cartItems').innerHTML = items.length
        ? items.map(item => `
            <div class="cart-row">

                <div>

                    <strong>${esc(item.name)}</strong>

                    <small>
                        SKU: ${esc(item.sku)} · ${money(item.price)} each
                    </small>

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

                        <button
                            class="remove-button"
                            data-remove="${esc(item.sku)}"
                        >
                            Remove
                        </button>

                    </div>

                </div>

                <div class="cart-row-price">
                    ${money(item.price * item.qty)}
                </div>

            </div>
        `).join('')
        : `
            <div class="empty">
                <strong>Your cart is empty</strong>
                <span>Add products from the catalog.</span>
            </div>
        `;

    const total = items.reduce(
        (sum, item) => sum + item.price * item.qty,
        0
    );

    $('cartTotal').textContent = money(total);

    $('sendOrder').disabled = !items.length;
    $('copyOrder').disabled = !items.length;

    // Decrease quantity
    $('cartItems').querySelectorAll('[data-minus]').forEach(button => {
        button.onclick = () => {
            changeQty(button.dataset.minus, -1);
        };
    });

    // Increase quantity
    $('cartItems').querySelectorAll('[data-plus]').forEach(button => {
        button.onclick = () => {
            changeQty(button.dataset.plus, 1);
        };
    });

    // Remove product
    $('cartItems').querySelectorAll('[data-remove]').forEach(button => {
        button.onclick = () => {
            delete cart[button.dataset.remove];
            saveCart();
        };
    });

    // Manual quantity input
    $('cartItems').querySelectorAll('[data-qty]').forEach(input => {
        input.onchange = () => {
            const quantity = Math.max(
                1,
                Math.floor(Number(input.value) || 1)
            );

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


/* =========================================================
   9. ORDER GENERATION
========================================================= */

function orderText() {
    const items = cartValues();

    const id = 'CAT-' +
        new Date().toISOString()
            .replace(/[-:TZ.]/g, '')
            .slice(0, 14);

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

    items.forEach(item => {
        lines.push(
            '',
            `${item.qty}x ${item.name}`,
            `  SKU: ${item.sku}`,
            `  Price: ${money(item.price)}`
        );
    });

    lines.push(
        '',
        `Total : ${money(total)}`
    );

    return {
        id,
        text: lines.join('\n'),
        items,
        total
    };
}


/* =========================================================
   10. SEND ORDER TO TELEGRAM
========================================================= */

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
        showToast(
            'Order is too long for the secure bot request. Copy it instead.'
        );
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

        const result = await jsonp(
            url + '?' + query.toString(),
            30000
        );

        if (!result.ok) {
            throw new Error(
                result.error || 'Telegram rejected the order'
            );
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
   11. CART PANEL
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


/* =========================================================
   12. SETTINGS PANEL
========================================================= */

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


function saveSettings() {
    settings = {
        scriptUrl: $('scriptUrl').value.trim(),
        pin: $('orderPin').value.trim()
    };

    localStorage.setItem(
        CONFIG.settingsKey,
        JSON.stringify(settings)
    );

    closeSettings();

    showToast('Settings saved');
}


/* =========================================================
   13. UI HELPERS
========================================================= */

function showToast(message) {
    $('toast').textContent = message;

    $('toast').classList.add('show');

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        $('toast').classList.remove('show');
    }, 2600);
}


/* =========================================================
   14. EVENT LISTENERS
========================================================= */

// Search
$('searchInput').addEventListener('input', renderProducts);

$('clearSearch').onclick = () => {
    $('searchInput').value = '';

    renderProducts();

    $('searchInput').focus();
};


// Catalog
$('refreshBtn').onclick = () => loadCatalog(true);


// Navigation
$('cartTop').onclick = openCart;
$('navCart').onclick = openCart;

$('navCatalog').onclick = () => {
    window.scrollTo({
        top: 0,
        behavior: 'smooth'
    });
};


// Cart panel
$('closeCart').onclick = closeCart;
$('cartOverlay').onclick = closeCart;


// Orders
$('sendOrder').onclick = sendOrder;
$('copyOrder').onclick = copyOrder;


// Settings panel
$('settingsButton').onclick = openSettings;
$('closeSettings').onclick = closeSettings;
$('settingsOverlay').onclick = closeSettings;
$('saveSettings').onclick = saveSettings;


/* =========================================================
   15. INITIALIZATION
========================================================= */

updateCartBadge();
renderCart();

loadSearchRules().then(() => {
    loadCatalog();
});


/* =========================================================
   16. SERVICE WORKER
========================================================= */

if (
    'serviceWorker' in navigator &&
    location.protocol.startsWith('http')
) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('./sw.js')
            .catch(() => {});
    });
}

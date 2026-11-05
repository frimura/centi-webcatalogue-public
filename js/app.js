'use strict';
const CONFIG={spreadsheetId:'1wTJRGfmdAARp9d_qNNQ1UUUssuNo5p9tarxPiYllGLo',gid:'0',currency:'IDR',cacheKey:'centi_catalog_rows_v1',cartKey:'centi_catalog_cart_v1',settingsKey:'centi_catalog_settings_v1'};
const $=id=>document.getElementById(id);
let products=[],cart=JSON.parse(localStorage.getItem(CONFIG.cartKey)||'{}'),settings=JSON.parse(localStorage.getItem(CONFIG.settingsKey)||'{}'),toastTimer;

// ================= SEARCH RULES =================

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

const csvUrl=`https://docs.google.com/spreadsheets/d/${CONFIG.spreadsheetId}/export?format=csv&gid=${CONFIG.gid}`;
function money(v){return new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Number(v)||0)}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function parseCSV(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(c==='"'&&quoted&&n==='"'){cell+='"';i++}else if(c==='"'){quoted=!quoted}else if(c===','&&!quoted){row.push(cell);cell=''}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&n==='\n')i++;row.push(cell);if(row.some(x=>x!==''))rows.push(row);row=[];cell=''}else cell+=c}if(cell.length||row.length){row.push(cell);rows.push(row)}return rows}
function normalize(rows){if(!rows.length)return[];const headers=rows[0].map(x=>x.trim().toLowerCase());const idx=name=>headers.indexOf(name.toLowerCase());const sku=idx('sku'),short=idx('nama pendek'),img=idx('images'),notes=idx('notes'),price=idx('regular price'),name=idx('name'),variation=idx('variation');if(sku<0||price<0)throw new Error('Required columns SKU and regular price were not found.');return rows.slice(1).map(r=>({sku:String(r[sku]||'').trim(),short:String(r[short]||'').trim(),image:String(r[img]||'').trim(),notes:String(r[notes]||'').trim(),price:Number(String(r[price]||'').replace(/[^0-9.-]/g,''))||0,name:String(r[name]||'').trim(),variation:String(r[variation]||'').trim()})).filter(p=>p.sku)}
function jsonp(url,timeoutMs=30000){return new Promise((resolve,reject)=>{const cb='centiJsonp_'+Date.now()+'_'+Math.floor(Math.random()*1e6);const script=document.createElement('script');let timer=setTimeout(()=>finish(new Error('Request timed out')),timeoutMs);function finish(err,data){clearTimeout(timer);delete window[cb];script.remove();err?reject(err):resolve(data)}window[cb]=data=>finish(null,data);script.onerror=()=>finish(new Error('Could not reach Apps Script'));script.src=url+(url.includes('?')?'&':'?')+'callback='+cb;document.head.appendChild(script)})}
async function loadCatalog(force=false){$('status').textContent='Connecting to Google Sheets…';$('status').classList.remove('error');$('refreshBtn').disabled=true;try{let rows;if(!force){const cached=localStorage.getItem(CONFIG.cacheKey);if(cached){try{rows=JSON.parse(cached)}catch{}}}if(!rows){let loadError;try{const res=await fetch(csvUrl,{cache:'no-store'});if(!res.ok)throw new Error(`Google Sheets returned HTTP ${res.status}`);const text=await res.text();rows=normalize(parseCSV(text));if(!rows.length)throw new Error('CSV export returned no product rows')}catch(e){loadError=e;if(settings.scriptUrl){const data=await jsonp(settings.scriptUrl+'?action=catalog');if(!data.ok)throw new Error(data.error||'Apps Script catalog request failed');rows=data.rows||[]}else throw e}if(!rows.length)throw new Error('No products found. Check sheet access and gid=0.');localStorage.setItem(CONFIG.cacheKey,JSON.stringify(rows));}products=rows;$('status').textContent=`${products.length.toLocaleString('id-ID')} products loaded${navigator.onLine?'':' · offline cache'}`;renderProducts()}catch(err){const cached=localStorage.getItem(CONFIG.cacheKey);if(cached){products=JSON.parse(cached);$('status').textContent=`Using saved catalog (${products.length.toLocaleString('id-ID')} products). Refresh failed: ${err.message}`;$('status').classList.add('error');renderProducts()}else{$('status').textContent=`Could not load catalog: ${err.message}`;$('status').classList.add('error');$('resultCount').textContent='Catalog unavailable'}}finally{$('refreshBtn').disabled=false}}
// ================= SEARCH ENGINE =================

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

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  const categories = SEARCH_RULES.categories || {};

  return products.map(product => {

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

    // Match each search word or its existing aliases
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

      for (const values of Object.values(rule.series || {})) {
        if (values.some(value =>
          normalizedQuery.includes(normalizeSearch(value)) &&
          name.includes(normalizeSearch(value))
        )) {
          score += 30;
        }
      }

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

// ================= PRODUCT RENDER =================

function renderProducts() {
  const query = $('searchInput').value.trim();
  const list = searchProducts(query);

  $('resultCount').textContent = query
    ? `${list.length.toLocaleString('id-ID')} matching products`
    : `Showing first ${list.length.toLocaleString('id-ID')} products`;

  const host = $('productList');

  host.innerHTML = list.slice(0, 160).map(p => `
    <article class="product-card">
      <div class="media">
        ${p.image
          ? `<img class="product-image" src="${esc(p.image)}"
              loading="lazy"
              referrerpolicy="no-referrer"
              onerror="this.outerHTML='<div class=&quot;image-placeholder&quot;>▧</div>'">`
          : `<div class="image-placeholder">▧</div>`}
      </div>

      <div class="product-info">
        <div class="product-name">${esc(p.short || p.sku)}</div>
        <div class="product-sku">SKU: ${esc(p.sku)}</div>
        <div class="product-variation">${esc(p.variation || p.notes || '')}</div>
        <div class="product-price">${money(p.price)}</div>

        <button class="add-button" data-add="${esc(p.sku)}">
          ＋ Add to cart
        </button>
      </div>
    </article>
  `).join('');

  $('emptyState').classList.toggle('hidden', list.length !== 0);

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
function addToCart(sku){const p=products.find(x=>x.sku===sku);if(!p)return;cart[sku]??={sku:p.sku,name:p.short||p.name,price:p.price,qty:0};cart[sku].qty++;saveCart();showToast('Added to cart')}
function saveCart(){localStorage.setItem(CONFIG.cartKey,JSON.stringify(cart));updateCartBadge();renderCart()}
function cartValues(){return Object.values(cart).filter(x=>x.qty>0)}
function updateCartBadge(){const count=cartValues().reduce((s,x)=>s+x.qty,0);$('cartCount').textContent=count;$('navCartCount').textContent=count}
function renderCart(){const items=cartValues();$('cartSubtitle').textContent=`${items.length} different products`;$('cartItems').innerHTML=items.length?items.map(x=>`<div class="cart-row"><div><strong>${esc(x.name)}</strong><small>SKU: ${esc(x.sku)} · ${money(x.price)} each</small><div class="qty-control"><button data-minus="${esc(x.sku)}">−</button><input data-qty="${esc(x.sku)}" type="number" min="1" step="1" value="${x.qty}"><button data-plus="${esc(x.sku)}">＋</button><button class="remove-button" data-remove="${esc(x.sku)}">Remove</button></div></div><div class="cart-row-price">${money(x.price*x.qty)}</div></div>`).join(''):'<div class="empty"><strong>Your cart is empty</strong><span>Add products from the catalog.</span></div>';$('cartTotal').textContent=money(items.reduce((s,x)=>s+x.price*x.qty,0));$('sendOrder').disabled=!items.length;$('copyOrder').disabled=!items.length;$('cartItems').querySelectorAll('[data-minus]').forEach(b=>b.onclick=()=>changeQty(b.dataset.minus,-1));$('cartItems').querySelectorAll('[data-plus]').forEach(b=>b.onclick=()=>changeQty(b.dataset.plus,1));$('cartItems').querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{delete cart[b.dataset.remove];saveCart()});$('cartItems').querySelectorAll('[data-qty]').forEach(i=>i.onchange=()=>{const q=Math.max(1,Math.floor(Number(i.value)||1));cart[i.dataset.qty].qty=q;saveCart()})}
function changeQty(sku,d){if(!cart[sku])return;cart[sku].qty+=d;if(cart[sku].qty<=0)delete cart[sku];saveCart()}
function orderText(){const items=cartValues();const id='CAT-'+new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14);const total=items.reduce((s,x)=>s+x.price*x.qty,0);let lines=[`New Order: ${id}`,'---------------------------------',`Pelanggan: Catalog Order`,'No : Mobile Catalog','','Pesanan :'];for(const x of items)lines.push('',`${x.qty}x ${x.name}`,`  SKU: ${x.sku}`,`  Price: ${money(x.price)}`);lines.push('',`Total : ${money(total)}`);return {id,text:lines.join('\n'),items,total}}
async function sendOrder(){const order=orderText();const url=(settings.scriptUrl||'').trim(),pin=(settings.pin||'').trim();if(!url){openSettings();showToast('Set your Apps Script URL first');return}if(!pin){openSettings();showToast('Enter the order access PIN');return}if(order.text.length>1500){showToast('Order is too long for the secure bot request. Copy it instead.');return}const btn=$('sendOrder');btn.disabled=true;btn.textContent='Sending…';try{const query=new URLSearchParams({action:'order',pin,payload:JSON.stringify(order)});const result=await jsonp(url+'?'+query.toString(),30000);if(!result.ok)throw new Error(result.error||'Telegram rejected the order');showToast('Order sent to Telegram');cart={};saveCart();closeCart()}catch(e){showToast(`Send failed: ${e.message}. You can copy the order instead.`)}finally{btn.disabled=false;btn.textContent='Send order to Telegram'}}
async function copyOrder(){try{await navigator.clipboard.writeText(orderText().text);showToast('Order copied')}catch{showToast('Clipboard unavailable in this browser')}}
function openCart(){$('cartOverlay').classList.remove('hidden');$('cartPanel').classList.add('open');$('cartPanel').setAttribute('aria-hidden','false')}
function closeCart(){$('cartOverlay').classList.add('hidden');$('cartPanel').classList.remove('open');$('cartPanel').setAttribute('aria-hidden','true')}
function openSettings(){$('settingsOverlay').classList.remove('hidden');$('settingsPanel').classList.remove('hidden');$('scriptUrl').value=settings.scriptUrl||'';$('orderPin').value=settings.pin||''}
function closeSettings(){$('settingsOverlay').classList.add('hidden');$('settingsPanel').classList.add('hidden')}
function showToast(msg){$('toast').textContent=msg;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2600)}
$('searchInput').addEventListener('input',renderProducts);$('clearSearch').onclick=()=>{$('searchInput').value='';renderProducts();$('searchInput').focus()};$('refreshBtn').onclick=()=>loadCatalog(true);$('cartTop').onclick=openCart;$('navCart').onclick=openCart;$('navCatalog').onclick=()=>window.scrollTo({top:0,behavior:'smooth'});$('closeCart').onclick=closeCart;$('cartOverlay').onclick=closeCart;$('sendOrder').onclick=sendOrder;$('copyOrder').onclick=copyOrder;$('settingsButton').onclick=openSettings;$('closeSettings').onclick=closeSettings;$('settingsOverlay').onclick=closeSettings;$('saveSettings').onclick=()=>{settings={scriptUrl:$('scriptUrl').value.trim(),pin:$('orderPin').value.trim()};localStorage.setItem(CONFIG.settingsKey,JSON.stringify(settings));closeSettings();showToast('Settings saved')};
updateCartBadge();
renderCart();

loadSearchRules().then(() => {
  loadCatalog();
});

if('serviceWorker'in navigator&&location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

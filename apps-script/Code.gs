/** Centi Catalog backend. Deploy as a Web App: Execute as Me; access Anyone.
 * Set Script Properties: SPREADSHEET_ID, SHEET_GID, TELEGRAM_BOT_TOKEN,
 * TELEGRAM_CHAT_ID, ORDER_PIN.
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const cb = p.callback || '';
  try {
    let result;
    if (p.action === 'order') result = sendOrder_(p);
    else result = { ok: true, rows: readCatalog_() };
    return output_(result, cb);
  } catch (err) {
    return output_({ ok: false, error: String(err.message || err) }, cb);
  }
}
function sendOrder_(params) {
  const props = PropertiesService.getScriptProperties();
  const expectedPin = props.getProperty('ORDER_PIN') || '';
  if (!expectedPin || String(params.pin || '') !== expectedPin) return {ok:false,error:'Invalid order PIN'};
  const raw = String(params.payload || '');
  if (raw.length > 9000) return {ok:false,error:'Order request is too large'};
  const order = JSON.parse(raw);
  if (!order || !Array.isArray(order.items) || !order.items.length || order.items.length > 80) return {ok:false,error:'Invalid order'};
  const message = String(order.text || '');
  if (!message || message.length > 3500) return {ok:false,error:'Telegram message is too long'};
  const token = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return {ok:false,error:'Telegram bot is not configured'};
  const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method:'post', contentType:'application/json', payload:JSON.stringify({chat_id:chatId,text:message}), muteHttpExceptions:true
  });
  const result = JSON.parse(response.getContentText());
  if (!result.ok) return {ok:false,error:'Telegram API error: ' + (result.description || response.getResponseCode())};
  return {ok:true,messageId:result.result.message_id};
}
function readCatalog_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('SPREADSHEET_ID');
  const gid = String(p.getProperty('SHEET_GID') || '0');
  if (!id) throw new Error('SPREADSHEET_ID is not configured');
  const ss = SpreadsheetApp.openById(id);
  const sheet = ss.getSheets().filter(s => String(s.getSheetId()) === gid)[0];
  if (!sheet) throw new Error('Sheet tab gid ' + gid + ' was not found');
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  const headers = values[0].map(x => String(x).trim().toLowerCase());
  const ix = name => headers.indexOf(name.toLowerCase());
  const sku=ix('sku'), short=ix('nama pendek'), image=ix('images'), notes=ix('notes'), price=ix('regular price'), name=ix('name'), variation=ix('variation');
  if (sku < 0 || price < 0) throw new Error('Required headers SKU and regular price are missing');
  return values.slice(1).filter(r=>r[sku]).map(r=>({sku:String(r[sku]),short:short<0?'':String(r[short]),image:image<0?'':String(r[image]),notes:notes<0?'':String(r[notes]),price:Number(String(r[price]||'').replace(/[^0-9.-]/g,''))||0,name:name<0?'':String(r[name]),variation:variation<0?'':String(r[variation])}));
}
function output_(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback && /^[a-zA-Z_$][\w.$]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

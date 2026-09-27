const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');

// Load local .env automatically when present. No external dotenv package needed.
(function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    const seenInFile = new Set();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // .env dosyasında aynı anahtar birden fazla kez tanımlanmışsa yalnızca İLKİ kullanılır
      // ve sonrakiler sessizce yok sayılır. Bu daha önce ADMIN_EMAIL/ADMIN_PASSWORD için
      // gerçek değerlerin hiç devreye girmemesine yol açmıştı, o yüzden burada uyarıyoruz.
      if (seenInFile.has(key)) {
        console.warn(`[env] UYARI: "${key}" .env dosyasında birden fazla kez tanımlanmış; yalnızca ilk değeri kullanılıyor, sonraki satır(lar) yok sayılıyor.`);
      }
      seenInFile.add(key);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (e) {
    console.error('[env] .env okunamadı:', e);
  }
})();

const PORT = Number(process.env.PORT || 3000);
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IYZICO_BASE = process.env.IYZICO_BASE_URL || 'https://api.iyzipay.com';
const IYZICO_API_KEY = process.env.IYZICO_API_KEY || '';
const IYZICO_SECRET_KEY = process.env.IYZICO_SECRET_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const STORE_EMAIL = process.env.STORE_EMAIL || '';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === 'true';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const PENDING_ORDER_TTL_MS = 1000 * 60 * 60 * 2;

const publicDir = __dirname;

// Turso (libSQL) bağlantısı. TURSO_DATABASE_URL tanımlıysa uzak Turso veritabanına,
// tanımlı değilse (yerel geliştirme) yerel bir SQLite dosyasına bağlanır — Turso hesabı
// olmadan da `npm start` ile hiçbir ek kurulum gerekmeden çalışır.
const db = createClient(
  process.env.TURSO_DATABASE_URL
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined }
    : { url: `file:${path.join(__dirname, 'biz-ve-siz.sqlite')}` }
);

// --- Küçük yardımcılar: node:sqlite'ın senkron prepare/get/run/all API'sine benzer,
// ama libSQL istemcisi asenkron olduğu için await ile kullanılıyor. ---
async function q(sql, args = []) { return db.execute({ sql, args }); }
async function qGet(sql, args = []) { const r = await q(sql, args); return r.rows[0]; }
async function qAll(sql, args = []) { const r = await q(sql, args); return r.rows; }
async function qRun(sql, args = []) { return q(sql, args); } // .rowsAffected / .lastInsertRowid

async function hasColumn(table, column) {
  const rows = await qAll(`PRAGMA table_info(${table})`);
  return rows.some(x => x.name === column);
}
async function addColumn(table, column, definition) {
  if (!(await hasColumn(table, column))) await q(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const PRODUCTS = {
  1:{name:'Bağ Yüzüğü',price:1450,cat:'Yüzük',stock:12},
  2:{name:'Damla Kolye',price:1980,cat:'Kolye',stock:12},
  3:{name:'İnce Zincir Bileklik',price:1120,cat:'Bileklik',stock:15},
  4:{name:'Sedef Küpe',price:1340,cat:'Küpe',stock:10},
  5:{name:'Taşlı Nişan Yüzüğü',price:3200,cat:'Yüzük',stock:6},
  6:{name:'Madalyon Kolye',price:2150,cat:'Kolye',stock:8},
  7:{name:'Zincir Bileklik',price:990,cat:'Bileklik',stock:15},
  8:{name:'Halka Küpe',price:1590,cat:'Küpe',stock:10}
};
const LAYERS={1:{name:'Choker',price:650,stock:10},2:{name:'Zincir Kolye',price:820,stock:10},3:{name:'Madalyon Kolye',price:960,stock:8}};

async function initDb() {
  await db.executeMultiple(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 salt TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
 token TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS orders(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER,
 conversation_id TEXT UNIQUE,
 iyzico_token TEXT UNIQUE,
 status TEXT NOT NULL,
 amount INTEGER NOT NULL,
 currency TEXT NOT NULL,
 customer_email TEXT NOT NULL,
 customer_name TEXT NOT NULL,
 address_json TEXT NOT NULL,
 items_json TEXT NOT NULL,
 payment_id TEXT,
 coupon_code TEXT,
 created_at TEXT NOT NULL,
 paid_at TEXT,
 reservation_expires_at INTEGER,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS inquiries(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 type TEXT NOT NULL,
 name TEXT NOT NULL,
 email TEXT NOT NULL,
 message TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory(
 product_key TEXT PRIMARY KEY,
 stock INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions(
 token TEXT PRIMARY KEY,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS password_resets(
 token TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 used_at INTEGER,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS coupons(
 code TEXT PRIMARY KEY,
 percent_off INTEGER NOT NULL,
 max_uses INTEGER,
 used_count INTEGER NOT NULL DEFAULT 0,
 min_amount INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER
);
`);

  await addColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn('users', 'verification_token', 'TEXT');
  await addColumn('users', 'verification_expires_at', 'INTEGER');
  await addColumn('orders', 'coupon_code', 'TEXT');
  await addColumn('orders', 'reservation_expires_at', 'INTEGER');

  await db.executeMultiple(`
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_inquiries_created ON inquiries(created_at);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets(expires_at);
`);

  for (const [id, p] of Object.entries(PRODUCTS)) await qRun('INSERT OR IGNORE INTO inventory(product_key,stock,updated_at) VALUES(?,?,?)', [String(id), p.stock, now()]);
  for (const [id, p] of Object.entries(LAYERS)) await qRun('INSERT OR IGNORE INTO inventory(product_key,stock,updated_at) VALUES(?,?,?)', [`layer-${id}`, p.stock, now()]);
  await qRun('INSERT OR IGNORE INTO coupons(code,percent_off,max_uses,min_amount,expires_at) VALUES(?,?,?,?,?)', ['WELCOME10', 10, 1000, 0, null]);
}

const rateBuckets = new Map();
const RATE_RULES = {
  login:{windowMs:15*60*1000,max:10}, register:{windowMs:60*60*1000,max:5}, payment:{windowMs:15*60*1000,max:10}, inquiry:{windowMs:15*60*1000,max:10}, coupon:{windowMs:15*60*1000,max:30}, admin:{windowMs:15*60*1000,max:10}
};
function clientIp(req){ return String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/,''); }
function rateLimit(req,res,key){
  const rule=RATE_RULES[key]; if(!rule)return true;
  const id=`${key}:${clientIp(req)}`, nowMs=Date.now(); let b=rateBuckets.get(id);
  if(!b || b.resetAt<=nowMs){b={count:0,resetAt:nowMs+rule.windowMs}; rateBuckets.set(id,b);}
  b.count++;
  if(b.count>rule.max){ json(res,429,{error:'Çok fazla deneme yapıldı. Lütfen biraz sonra tekrar deneyin.'},{'Retry-After':String(Math.ceil((b.resetAt-nowMs)/1000))}); return false; }
  return true;
}
// NOT: Bu rate-limit belleği tek bir process içinde tutuluyor. Kalıcı/sürekli çalışan bir
// sunucuda (Railway, Render, VPS) güvenilir şekilde çalışır. Vercel gibi çoklu-instance
// serverless ortamlarda instance'lar arası paylaşılmadığı için garanti değildir — ciddi bir
// trafik/abuse riski varsa Upstash Redis gibi paylaşılan bir store'a taşınmalıdır.
setInterval(()=>{ const nowMs=Date.now(); for(const [k,v] of rateBuckets) if(v.resetAt<=nowMs) rateBuckets.delete(k); },10*60*1000).unref();

function securityHeaders(){
  const h={
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Referrer-Policy':'strict-origin-when-cross-origin',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self' https://*.iyzico.com https://*.iyzipay.com"
  };
  if(APP_URL.startsWith('https://')) h['Strict-Transport-Security']='max-age=31536000; includeSubDomains';
  return h;
}
function json(res,status,data,headers={}){
  const body=JSON.stringify(data);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...securityHeaders(),...headers});
  res.end(body);
}
function parseCookies(req){
  const out={}; const raw=req.headers.cookie||'';
  for(const part of raw.split(';')){const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}
  return out;
}
function cookieFlags(maxAge, httpOnly){ return `Path=/; ${httpOnly?'HttpOnly; ':''}SameSite=Lax; ${APP_URL.startsWith('https://')?'Secure; ':''}Max-Age=${maxAge}`; }
async function setSession(res,userId){
  const token=crypto.randomBytes(32).toString('hex'); const exp=Date.now()+SESSION_TTL_MS;
  await qRun('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)',[token,userId,exp]);
  res.setHeader('Set-Cookie',`bvs_session=${token}; ${cookieFlags(2592000,true)}`);
}
function setCsrfCookie(res,token){ res.setHeader('Set-Cookie',`bvs_csrf=${token}; ${cookieFlags(86400,false)}`); }
function csrfToken(req,res){
  const cookies=parseCookies(req); let token=cookies.bvs_csrf;
  if(!token){token=crypto.randomBytes(24).toString('hex');setCsrfCookie(res,token);} return token;
}
function requireCsrf(req,res){
  const c=parseCookies(req).bvs_csrf, h=req.headers['x-csrf-token'];
  if(!c || !h || c.length<32 || c.length!==String(h).length || !crypto.timingSafeEqual(Buffer.from(c),Buffer.from(String(h)))){json(res,403,{error:'Güvenlik doğrulaması başarısız. Sayfayı yenileyip tekrar deneyin.'});return false;}
  return true;
}
async function currentUser(req){
  const token=parseCookies(req).bvs_session; if(!token)return null;
  const row=await qGet('SELECT u.id,u.name,u.email,u.email_verified,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?',[token]);
  if(!row || row.expires_at<Date.now()){if(row)await qRun('DELETE FROM sessions WHERE token=?',[token]);return null;} return row;
}
async function adminUser(req){ const token=parseCookies(req).bvs_admin; if(!token)return false; const row=await qGet('SELECT token FROM admin_sessions WHERE token=? AND expires_at>?',[token,Date.now()]); return !!row; }
async function setAdminSession(res){const token=crypto.randomBytes(32).toString('hex');await qRun('INSERT INTO admin_sessions(token,expires_at) VALUES(?,?)',[token,Date.now()+1000*60*60*12]);res.setHeader('Set-Cookie',`bvs_admin=${token}; ${cookieFlags(43200,true)}`);}
function body(req){
  return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>{raw+=c;if(raw.length>1e6){reject(new Error('Payload too large'));req.destroy();}});req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{});}catch(e){reject(new Error('Geçersiz JSON'));}});req.on('error',reject);});
}
function formBody(req){return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>resolve(new URLSearchParams(raw)));req.on('error',reject);});}
function passwordHash(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
function validEmail(e){return typeof e==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);}
function validateIdentity(n){
  const s=String(n||''); if(!/^\d{11}$/.test(s) || s[0]==='0')return false;
  const d=[...s].map(Number); const odd=d[0]+d[2]+d[4]+d[6]+d[8], even=d[1]+d[3]+d[5]+d[7];
  const d10=((odd*7-even)%10+10)%10; const d11=d.slice(0,10).reduce((a,b)=>a+b,0)%10;
  return d10===d[9] && d11===d[10];
}
function now(){return new Date().toISOString();}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
// Şifre gibi gizli değerleri sabit-zamanlı karşılaştırır (uzunluk farkı bile bilgi sızdırmasın
// diye önce sabit uzunluklu bir hash'e indirger).
function timingSafeStringEqual(a,b){
  const ha=crypto.createHash('sha256').update(String(a??'')).digest();
  const hb=crypto.createHash('sha256').update(String(b??'')).digest();
  return crypto.timingSafeEqual(ha,hb);
}

async function sendEmail({to,subject,html}){
  if(!to || !RESEND_API_KEY || !MAIL_FROM){
    if(!IS_PRODUCTION) console.log(`[email-dev] ${subject} -> ${to||'(no recipient)'}`);
    return false;
  }
  try{
    const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:MAIL_FROM,to:[to],subject,html})});
    if(!r.ok){console.error('[email] Resend error',r.status,await r.text());return false;} return true;
  }catch(e){console.error('[email] send failed',e);return false;}
}
function logError(context,e){ console.error(`[${new Date().toISOString()}] ${context}`,e?.stack||e); }

function iyzicoAuth(uriPath,payload){
  const rnd=Date.now().toString()+crypto.randomBytes(8).toString('hex');
  const bodyText=payload && Object.keys(payload).length ? JSON.stringify(payload) : '';
  const signature=crypto.createHmac('sha256',IYZICO_SECRET_KEY).update(rnd+uriPath+bodyText).digest('hex');
  const authString=`apiKey:${IYZICO_API_KEY}&randomKey:${rnd}&signature:${signature}`;
  return {Authorization:'IYZWSv2 '+Buffer.from(authString,'utf8').toString('base64'),'x-iyzi-rnd':rnd};
}
async function iyzicoPost(uriPath,payload){
  const r=await fetch(IYZICO_BASE+uriPath,{method:'POST',headers:{'Content-Type':'application/json',...iyzicoAuth(uriPath,payload)},body:JSON.stringify(payload)});
  const data=await r.json().catch(()=>({})); if(!r.ok || data.status==='failure') throw new Error(data.errorMessage||`iyzico HTTP ${r.status}`); return data;
}
function normalizeItems(items){
  if(!Array.isArray(items)||!items.length)throw new Error('Sepet boş.');
  const out=[];
  for(const x of items){
    const qty=Math.max(1,Math.min(20,Math.floor(Number(x.qty)||0)));
    if(x.bundle){
      const selected=Array.isArray(x.bundleItems)?[...new Set(x.bundleItems.map(Number).filter(n=>LAYERS[n]))]:[];
      if(!selected.length)throw new Error('Katmanlı kombin boş.');
      const price=selected.reduce((sum,id)=>sum+LAYERS[id].price,0);
      out.push({id:'layer-bundle',name:'Katmanlı Kombin',price,qty,category:'Kolye',itemType:'PHYSICAL',inventoryKeys:selected.map(id=>`layer-${id}`)});
    }else{
      const id=Number(x.id),p=PRODUCTS[id]; if(!p)throw new Error('Geçersiz ürün.');
      out.push({id:String(id),name:p.name,price:p.price,qty,category:p.cat,itemType:'PHYSICAL',inventoryKeys:[String(id)]});
    }
  }
  return out;
}
function inventoryRequirements(items){
  const req=new Map(); for(const item of items) for(const key of item.inventoryKeys) req.set(key,(req.get(key)||0)+item.qty); return req;
}
async function reserveStock(items){
  const req=inventoryRequirements(items);
  const tx=await db.transaction('write');
  try{
    for(const [key,qty] of req){const row=(await tx.execute({sql:'SELECT stock FROM inventory WHERE product_key=?',args:[key]})).rows[0];if(!row || row.stock<qty)throw new Error(`Stok yetersiz: ${PRODUCTS[Number(key)]?.name || LAYERS[Number(String(key).replace('layer-',''))]?.name || key}`);}
    for(const [key,qty] of req) await tx.execute({sql:'UPDATE inventory SET stock=stock-?,updated_at=? WHERE product_key=?',args:[qty,now(),key]});
    await tx.commit(); return true;
  }catch(e){await tx.rollback();throw e;}
}
async function releaseStock(items){
  const req=inventoryRequirements(items);
  const tx=await db.transaction('write');
  try{for(const [key,qty] of req) await tx.execute({sql:'UPDATE inventory SET stock=stock+?,updated_at=? WHERE product_key=?',args:[qty,now(),key]});await tx.commit();}catch(e){await tx.rollback();throw e;}
}
async function finalizePendingOrder(orderId, newStatus, items){
  const tx=await db.transaction('write');
  try{
    const row=(await tx.execute({sql:'SELECT status FROM orders WHERE id=?',args:[orderId]})).rows[0];
    if(!row || row.status!=='PENDING'){await tx.rollback();return false;}
    const req=inventoryRequirements(items);
    for(const [key,qty] of req) await tx.execute({sql:'UPDATE inventory SET stock=stock+?,updated_at=? WHERE product_key=?',args:[qty,now(),key]});
    await tx.execute({sql:"UPDATE orders SET status=?,reservation_expires_at=NULL WHERE id=? AND status='PENDING'",args:[newStatus,orderId]});
    await tx.commit(); return true;
  }catch(e){await tx.rollback();throw e;}
}
async function deletePendingOrderAndRelease(orderId,items){
  const tx=await db.transaction('write');
  try{
    const row=(await tx.execute({sql:'SELECT status FROM orders WHERE id=?',args:[orderId]})).rows[0];
    if(!row || row.status!=='PENDING'){await tx.rollback();return false;}
    const req=inventoryRequirements(items);
    for(const [key,qty] of req) await tx.execute({sql:'UPDATE inventory SET stock=stock+?,updated_at=? WHERE product_key=?',args:[qty,now(),key]});
    await tx.execute({sql:"DELETE FROM orders WHERE id=? AND status='PENDING'",args:[orderId]});
    await tx.commit(); return true;
  }catch(e){await tx.rollback();throw e;}
}

async function cleanupExpiredReservations(){
  const cutoff=Date.now(); const rows=await qAll("SELECT * FROM orders WHERE status='PENDING' AND reservation_expires_at IS NOT NULL AND reservation_expires_at<?",[cutoff]);
  for(const order of rows){try{if(await finalizePendingOrder(order.id,'EXPIRED',JSON.parse(order.items_json)))console.log(`[stock] released expired order ${order.id}`);}catch(e){logError(`stock cleanup order ${order.id}`,e);}}
}
setInterval(()=>{(async()=>{try{await qRun('DELETE FROM sessions WHERE expires_at<?',[Date.now()]);await qRun('DELETE FROM admin_sessions WHERE expires_at<?',[Date.now()]);await qRun('DELETE FROM password_resets WHERE expires_at<? OR used_at IS NOT NULL',[Date.now()]);await cleanupExpiredReservations();}catch(e){logError('maintenance cleanup',e);}})();},5*60*1000).unref();

async function couponFor(code,amount){
  if(!code)return null; const row=await qGet('SELECT * FROM coupons WHERE code=?',[String(code).trim().toUpperCase()]); if(!row)return null;
  if(row.expires_at && row.expires_at<Date.now())return null; if(row.max_uses!==null && row.used_count>=row.max_uses)return null; if(amount<row.min_amount)return null; return row;
}

async function handle(req,res){
  const u=new URL(req.url,APP_URL);
  // CSRF bootstrap
  if(req.method==='GET' && u.pathname==='/api/auth/csrf'){const token=csrfToken(req,res);return json(res,200,{token});}
  if(req.method==='GET' && u.pathname==='/api/auth/me'){const user=await currentUser(req);if(!user)return json(res,401,{error:'Giriş yapılmamış.'});return json(res,200,{id:user.id,name:user.name,email:user.email,emailVerified:!!user.email_verified});}
  if(req.method==='GET' && u.pathname==='/api/catalog'){
    const rows=await qAll('SELECT product_key,stock FROM inventory'); const stock=Object.fromEntries(rows.map(r=>[r.product_key,r.stock])); return json(res,200,{products:Object.entries(PRODUCTS).map(([id,p])=>({id:Number(id),...p,stock:stock[id]??0})),layers:Object.entries(LAYERS).map(([id,p])=>({id:Number(id),...p,stock:stock[`layer-${id}`]??0}))});
  }
  if(req.method==='GET' && u.pathname==='/api/orders'){
    const user=await currentUser(req);if(!user)return json(res,401,{error:'Giriş yapılmamış.'});
    const rows=await qAll('SELECT id,status,amount,currency,customer_name,items_json,coupon_code,created_at,paid_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 50',[user.id]);
    return json(res,200,{orders:rows.map(o=>({...o,items:JSON.parse(o.items_json)}))});
  }
  if(req.method==='POST' && u.pathname==='/api/auth/register'){
    if(!rateLimit(req,res,'register')||!requireCsrf(req,res))return;
    try{
      const b=await body(req),name=String(b.name||'').trim(),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
      if(name.length<2||!validEmail(email)||password.length<8)return json(res,400,{error:'Ad, geçerli e-posta ve en az 8 karakterli şifre gerekli.'});
      const salt=crypto.randomBytes(16).toString('hex'),hash=passwordHash(password,salt);let verificationToken=null,verificationExpires=null;
      if(REQUIRE_EMAIL_VERIFICATION){verificationToken=crypto.randomBytes(32).toString('hex');verificationExpires=Date.now()+1000*60*60*24;}
      const result=await qRun('INSERT INTO users(name,email,password_hash,salt,created_at,email_verified,verification_token,verification_expires_at) VALUES(?,?,?,?,?,?,?,?)',[name,email,hash,salt,now(),REQUIRE_EMAIL_VERIFICATION?0:1,verificationToken,verificationExpires]);
      if(REQUIRE_EMAIL_VERIFICATION){const link=`${APP_URL}/api/auth/verify-email?token=${verificationToken}`;await sendEmail({to:email,subject:'biz ve siz e-posta doğrulama',html:`<p>Merhaba ${escapeHtml(name)},</p><p>Hesabınızı doğrulamak için <a href="${link}">bu bağlantıya tıklayın</a>.</p>`});return json(res,201,{message:'Hesabınız oluşturuldu. E-posta adresinizi doğrulamak için gelen kutunuzu kontrol edin.'});}
      await setSession(res,Number(result.lastInsertRowid));return json(res,201,{message:'Hesabınız oluşturuldu ve giriş yapıldı.'});
    }catch(e){logError('auth/register',e);const isUnique=String(e.code||'').includes('CONSTRAINT')||/unique/i.test(e.message||'');return json(res,400,{error:isUnique?'Bu e-posta zaten kayıtlı.':'Kayıt oluşturulamadı.'});}
  }
  if(req.method==='GET' && u.pathname==='/api/auth/verify-email'){
    try{const token=u.searchParams.get('token');const row=await qGet('SELECT * FROM users WHERE verification_token=?',[token]);if(!row||!row.verification_expires_at||row.verification_expires_at<Date.now())return redirect(res,`${APP_URL}/?verified=failed`);await qRun('UPDATE users SET email_verified=1,verification_token=NULL,verification_expires_at=NULL WHERE id=?',[row.id]);await setSession(res,row.id);return redirect(res,`${APP_URL}/?verified=success`);}catch(e){logError('auth/verify-email',e);return redirect(res,`${APP_URL}/?verified=failed`);}
  }
  if(req.method==='POST' && u.pathname==='/api/auth/login'){
    if(!rateLimit(req,res,'login')||!requireCsrf(req,res))return;
    try{const b=await body(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');const row=await qGet('SELECT * FROM users WHERE email=?',[email]);if(!row)return json(res,401,{error:'E-posta veya şifre hatalı.'});if(REQUIRE_EMAIL_VERIFICATION&&!row.email_verified)return json(res,403,{error:'Önce e-posta adresinizi doğrulayın.'});const hash=passwordHash(password,row.salt);if(!crypto.timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(row.password_hash,'hex')))return json(res,401,{error:'E-posta veya şifre hatalı.'});await setSession(res,row.id);return json(res,200,{message:'Giriş yapıldı.',name:row.name});}catch(e){logError('auth/login',e);return json(res,400,{error:'Giriş yapılamadı.'});}
  }
  if(req.method==='POST' && u.pathname==='/api/auth/logout'){
    if(!requireCsrf(req,res))return; const token=parseCookies(req).bvs_session;if(token)await qRun('DELETE FROM sessions WHERE token=?',[token]);return json(res,200,{message:'Çıkış yapıldı.'},{'Set-Cookie':`bvs_session=; ${cookieFlags(0,true)}`});
  }
  if(req.method==='POST' && u.pathname==='/api/auth/forgot-password'){
    if(!rateLimit(req,res,'login')||!requireCsrf(req,res))return; try{const b=await body(req),email=String(b.email||'').trim().toLowerCase(),row=await qGet('SELECT id,name FROM users WHERE email=?',[email]);if(row){const token=crypto.randomBytes(32).toString('hex');await qRun('INSERT INTO password_resets(token,user_id,expires_at) VALUES(?,?,?)',[token,row.id,Date.now()+1000*60*30]);const link=`${APP_URL}/?reset=${token}`;await sendEmail({to:email,subject:'biz ve siz şifre yenileme',html:`<p>Merhaba ${escapeHtml(row.name)},</p><p>Şifrenizi yenilemek için <a href="${link}">bu bağlantıyı kullanın</a>. Bağlantı 30 dakika geçerlidir.</p>`});if(!RESEND_API_KEY&&!IS_PRODUCTION)console.log(`[password-reset-dev] ${link}`);}return json(res,200,{message:'Eğer bu e-posta kayıtlıysa şifre yenileme bağlantısı gönderildi.'});}catch(e){logError('auth/forgot-password',e);return json(res,200,{message:'Eğer bu e-posta kayıtlıysa şifre yenileme bağlantısı gönderildi.'});}
  }
  if(req.method==='POST' && u.pathname==='/api/auth/reset-password'){
    if(!rateLimit(req,res,'login')||!requireCsrf(req,res))return;try{const b=await body(req),token=String(b.token||''),password=String(b.password||'');if(password.length<8)return json(res,400,{error:'Şifre en az 8 karakter olmalı.'});const row=await qGet('SELECT * FROM password_resets WHERE token=? AND used_at IS NULL AND expires_at>?',[token,Date.now()]);if(!row)return json(res,400,{error:'Geçersiz veya süresi dolmuş bağlantı.'});const salt=crypto.randomBytes(16).toString('hex'),hash=passwordHash(password,salt);await qRun('UPDATE users SET password_hash=?,salt=? WHERE id=?',[hash,salt,row.user_id]);await qRun('UPDATE password_resets SET used_at=? WHERE token=?',[Date.now(),token]);await qRun('DELETE FROM sessions WHERE user_id=?',[row.user_id]);return json(res,200,{message:'Şifreniz yenilendi. Yeni şifrenizle giriş yapabilirsiniz.'});}catch(e){logError('auth/reset-password',e);return json(res,400,{error:'Şifre yenilenemedi.'});}
  }
  if(req.method==='POST' && u.pathname==='/api/inquiries'){
    if(!rateLimit(req,res,'inquiry')||!requireCsrf(req,res))return;try{const b=await body(req),type=['contact','special'].includes(b.type)?b.type:'contact',name=String(b.name||'').trim(),email=String(b.email||'').trim(),message=String(b.message||'').trim();if(name.length<2||!validEmail(email)||message.length<3)return json(res,400,{error:'Form alanlarını kontrol edin.'});await qRun('INSERT INTO inquiries(type,name,email,message,created_at) VALUES(?,?,?,?,?)',[type,name,email,message,now()]);if(STORE_EMAIL)await sendEmail({to:STORE_EMAIL,subject:`biz ve siz yeni ${type==='special'?'özel sipariş':'iletişim'} talebi`,html:`<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)})</p><p>${escapeHtml(message)}</p>`});return json(res,201,{message:'Talebiniz kaydedildi.'});}catch(e){logError('inquiries',e);return json(res,400,{error:'Talep kaydedilemedi.'});}
  }
  if(req.method==='POST' && u.pathname==='/api/coupons/validate'){
    if(!rateLimit(req,res,'coupon')||!requireCsrf(req,res))return;try{const b=await body(req),amount=Math.max(0,Math.round(Number(b.amount)||0)),code=String(b.code||'').trim().toUpperCase(),row=await couponFor(code,amount);if(!row)return json(res,400,{error:'Kupon geçersiz, süresi dolmuş veya koşulları karşılamıyor.'});const discount=Math.floor(amount*row.percent_off/100);return json(res,200,{code:row.code,percentOff:row.percent_off,discount,total:amount-discount});}catch(e){logError('coupons/validate',e);return json(res,400,{error:'Kupon doğrulanamadı.'});}
  }
  if(req.method==='POST' && u.pathname==='/api/payment/initialize'){
    if(!rateLimit(req,res,'payment')||!requireCsrf(req,res))return;
    let reservedItems=null, orderId=null;
    try{
      if(!IYZICO_API_KEY||!IYZICO_SECRET_KEY)return json(res,503,{error:'Ödeme sağlayıcısı henüz yapılandırılmadı. Sunucuda IYZICO_API_KEY ve IYZICO_SECRET_KEY tanımlanmalı.'});
      const b=await body(req),items=normalizeItems(b.items),subtotal=items.reduce((sum,x)=>sum+x.price*x.qty,0),coupon=await couponFor(b.couponCode,subtotal),discount=coupon?Math.floor(subtotal*coupon.percent_off/100):0,amount=subtotal-discount;
      const email=String(b.email||'').trim().toLowerCase();if(!validEmail(email))return json(res,400,{error:'Geçerli e-posta girin.'});
      if(!validateIdentity(b.identityNumber))return json(res,400,{error:'Geçerli 11 haneli T.C. Kimlik No gerekli.'});
      const conversationId=crypto.randomUUID(),buyerName=String(b.name||'').trim(),surname=String(b.surname||'').trim(),address=String(b.address||'').trim(),city=String(b.city||'').trim(),zipCode=String(b.zipCode||'').trim(),gsm=String(b.gsmNumber||'').trim();
      if(!buyerName||!surname||!address||!city||!zipCode||!gsm)return json(res,400,{error:'Teslimat bilgilerini eksiksiz doldurun.'});
      reservedItems=items;await reserveStock(items);const user=await currentUser(req);const basketItems=items.map(x=>({id:x.id,price:(x.price*x.qty).toFixed(2),name:x.name,category1:x.category,itemType:x.itemType}));
      const orderResult=await qRun('INSERT INTO orders(user_id,conversation_id,status,amount,currency,customer_email,customer_name,address_json,items_json,coupon_code,created_at,reservation_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[user?user.id:null,conversationId,'PENDING',amount,'TRY',email,`${buyerName} ${surname}`,JSON.stringify({address,city,zipCode,gsm}),JSON.stringify(items),coupon?.code||null,now(),Date.now()+PENDING_ORDER_TTL_MS]);orderId=Number(orderResult.lastInsertRowid);
      const payload={locale:'tr',conversationId,price:amount.toFixed(2),paidPrice:amount.toFixed(2),currency:'TRY',basketId:conversationId,paymentGroup:'PRODUCT',callbackUrl:`${APP_URL}/api/payment/callback`,enabledInstallments:[1,2,3,6,9],buyer:{id:user?String(user.id):`guest-${conversationId.slice(0,8)}`,name:buyerName,surname,identityNumber:String(b.identityNumber),email,gsmNumber:gsm,registrationAddress:address,city,country:'Turkey',zipCode,ip:req.socket.remoteAddress||'127.0.0.1'},shippingAddress:{address,zipCode,contactName:`${buyerName} ${surname}`,city,country:'Turkey'},billingAddress:{address,zipCode,contactName:`${buyerName} ${surname}`,city,country:'Turkey'},basketItems};
      const data=await iyzicoPost('/payment/iyzipos/checkoutform/initialize/auth/ecom',payload);if(!data.paymentPageUrl||!data.token)throw new Error('Ödeme sayfası oluşturulamadı.');await qRun('UPDATE orders SET iyzico_token=? WHERE id=?',[data.token,orderId]);return json(res,200,{paymentPageUrl:data.paymentPageUrl,token:data.token,discount});
    }catch(e){logError('payment/initialize',e);if(res.writableEnded)return;if(orderId&&reservedItems){try{await deletePendingOrderAndRelease(orderId,reservedItems);}catch(err){logError('payment atomic rollback',err);}}return json(res,400,{error:e.message||'Ödeme başlatılamadı.'});}
  }
  if(req.method==='POST' && u.pathname==='/api/payment/callback'){
    try{
      const f=await formBody(req),token=f.get('token');if(!token)return redirect(res,`${APP_URL}/?payment=failed`);const order=await qGet('SELECT * FROM orders WHERE iyzico_token=?',[token]);if(!order)return redirect(res,`${APP_URL}/?payment=failed`);if(order.status==='PAID')return redirect(res,`${APP_URL}/?payment=success&order=${order.id}`);
      const data=await iyzicoPost('/payment/iyzipos/checkoutform/auth/ecom/detail',{locale:'tr',conversationId:order.conversation_id,token});
      if(data.paymentStatus==='SUCCESS'&&Number(data.fraudStatus)===1){
        const tx=await db.transaction('write');let changed=false;try{const r=await tx.execute({sql:"UPDATE orders SET status='PAID',payment_id=?,paid_at=?,reservation_expires_at=NULL WHERE id=? AND status='PENDING'",args:[data.paymentId||null,now(),order.id]});changed=r.rowsAffected===1;if(changed&&order.coupon_code)await tx.execute({sql:'UPDATE coupons SET used_count=used_count+1 WHERE code=?',args:[order.coupon_code]});await tx.commit();}catch(e){await tx.rollback();throw e;}
        if(changed){await sendOrderEmails(order,data.paymentId||null);return redirect(res,`${APP_URL}/?payment=success&order=${order.id}`);}
        return redirect(res,`${APP_URL}/?payment=success&order=${order.id}`);
      }
      if(order.status==='PENDING'){try{await finalizePendingOrder(order.id,data.paymentStatus==='SUCCESS'?'REVIEW':'FAILED',JSON.parse(order.items_json));}catch(e){logError(`payment callback stock rollback ${order.id}`,e);}}return redirect(res,`${APP_URL}/?payment=failed`);
    }catch(e){logError('payment/callback',e);return redirect(res,`${APP_URL}/?payment=failed`);}
  }
  if(req.method==='POST' && u.pathname==='/api/admin/login'){
    if(!rateLimit(req,res,'admin')||!requireCsrf(req,res))return;try{if(!ADMIN_EMAIL||!ADMIN_PASSWORD)return json(res,503,{error:'Admin hesabı sunucuda yapılandırılmadı.'});const b=await body(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');if(email!==ADMIN_EMAIL||!timingSafeStringEqual(password,ADMIN_PASSWORD))return json(res,401,{error:'Admin bilgileri hatalı.'});await setAdminSession(res);return json(res,200,{message:'Admin girişi başarılı.'});}catch(e){logError('admin/login',e);return json(res,400,{error:'Admin girişi başarısız.'});}
  }
  if(req.method==='POST' && u.pathname==='/api/admin/logout'){
    if(!requireCsrf(req,res))return;const token=parseCookies(req).bvs_admin;if(token)await qRun('DELETE FROM admin_sessions WHERE token=?',[token]);return json(res,200,{message:'Çıkış yapıldı.'},{'Set-Cookie':`bvs_admin=; ${cookieFlags(0,true)}`});
  }
  if(u.pathname.startsWith('/api/admin/')){
    if(!(await adminUser(req)))return json(res,401,{error:'Admin girişi gerekli.'});
    if(req.method==='GET'&&u.pathname==='/api/admin/orders'){const status=u.searchParams.get('status');const rows=status?await qAll('SELECT id,status,amount,currency,customer_email,customer_name,items_json,coupon_code,created_at,paid_at FROM orders WHERE status=? ORDER BY id DESC LIMIT 200',[status]):await qAll('SELECT id,status,amount,currency,customer_email,customer_name,items_json,coupon_code,created_at,paid_at FROM orders ORDER BY id DESC LIMIT 200');return json(res,200,{orders:rows.map(x=>({...x,items:JSON.parse(x.items_json)}))});}
    if(req.method==='GET'&&u.pathname==='/api/admin/inquiries'){return json(res,200,{inquiries:await qAll('SELECT id,type,name,email,message,created_at FROM inquiries ORDER BY id DESC LIMIT 200')});}
    if(req.method==='GET'&&u.pathname==='/api/admin/inventory'){return json(res,200,{inventory:await qAll('SELECT product_key,stock,updated_at FROM inventory ORDER BY product_key')});}
  }
  // Static files: asynchronous filesystem calls so the event loop is not blocked.
  let file=u.pathname==='/'?'/index.html':(u.pathname==='/admin'?'/admin.html':decodeURIComponent(u.pathname));const safe=path.posix.normalize(file).replace(/^\/+/, '');const fp=path.resolve(publicDir,safe);if(fp!==path.resolve(publicDir)&&!fp.startsWith(path.resolve(publicDir)+path.sep))return json(res,403,{error:'Forbidden'});
  try{
    const st=await fs.promises.stat(fp);
    if(st.isFile()){
      const ext=path.extname(fp).toLowerCase(),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8','.ico':'image/x-icon','.webmanifest':'application/manifest+json; charset=utf-8'};const cache=ext==='.html'?'no-cache':'public, max-age=604800';res.writeHead(200,{...securityHeaders(),'Content-Type':types[ext]||'application/octet-stream','Cache-Control':cache});fs.createReadStream(fp).pipe(res);return;
    }
  }catch(e){if(e.code!=='ENOENT') logError('static file',e);}
  return json(res,404,{error:'Not found'});
}
async function sendOrderEmails(order,paymentId){
  const items=JSON.parse(order.items_json);const lines=items.map(x=>`<li>${escapeHtml(x.name)} × ${x.qty} — ₺${(x.price*x.qty).toLocaleString('tr-TR')}</li>`).join('');
  await sendEmail({to:order.customer_email,subject:`biz ve siz sipariş #${order.id} onaylandı`,html:`<p>Merhaba ${escapeHtml(order.customer_name)},</p><p>Siparişiniz başarıyla ödendi.</p><ul>${lines}</ul><p><strong>Toplam: ₺${order.amount.toLocaleString('tr-TR')}</strong></p><p>Sipariş no: #${order.id}</p>`});
  if(STORE_EMAIL)await sendEmail({to:STORE_EMAIL,subject:`Yeni ödenmiş sipariş #${order.id}`,html:`<p>${escapeHtml(order.customer_name)} — ${escapeHtml(order.customer_email)}</p><p>Toplam: ₺${order.amount.toLocaleString('tr-TR')}</p><p>Ödeme ID: ${escapeHtml(paymentId||'')}</p><ul>${lines}</ul>`});
}
function redirect(res,location){res.writeHead(302,{...securityHeaders(),Location:location,'Cache-Control':'no-store'});res.end();}

initDb().then(()=>{
  http.createServer((req,res)=>{handle(req,res).catch(e=>{logError('unhandled request',e);if(!res.headersSent)json(res,500,{error:'Sunucu hatası.'});});}).listen(PORT,()=>console.log(`biz ve siz running on ${APP_URL}`));
}).catch(e=>{
  console.error('[db] Veritabanı başlatılamadı:', e);
  process.exit(1);
});

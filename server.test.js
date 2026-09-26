// Sunucu için entegrasyon testleri. Hiçbir ek paket gerekmez —
// sadece Node.js'in yerleşik test çalıştırıcısını (node:test) kullanır.
//
// Çalıştırmak için proje kök klasöründe: npm test
//
// Testler, server.js'i ayrı bir geçici klasörde, ayrı bir port ve boş bir
// veritabanıyla gerçek bir alt süreç (child process) olarak başlatır, sonra
// gerçek HTTP istekleriyle (fetch) uçtan uca doğrular. Böylece server.js'i
// hiç değiştirmeden / export eklemeden test edebiliyoruz.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 34567;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'test-admin@example.com';
const ADMIN_PASSWORD = 'test-password-123';

let serverProcess;
let tmpDir;

// ---- basit çerez kavanozu (cookie jar) -----------------------------------
function makeJar() {
  const jar = new Map();
  return {
    apply(headers = {}) {
      if (jar.size === 0) return headers;
      const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      return { ...headers, Cookie: cookieHeader };
    },
    store(res) {
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of setCookies) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
  };
}

async function req(jar, method, urlPath, body, extraHeaders = {}) {
  const headers = jar.apply({ 'Content-Type': 'application/json', ...extraHeaders });
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  jar.store(res);
  let data = null;
  try { data = await res.json(); } catch { /* JSON olmayan yanıt (ör. redirect) olabilir */ }
  return { status: res.status, data, res };
}

async function getCsrf(jar) {
  const { data } = await req(jar, 'GET', '/api/auth/csrf');
  return data.token;
}

// ---- sunucuyu ayrı bir klasörde, ayrı portta başlat / kapat ---------------
test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bvs-test-'));
  fs.copyFileSync(path.join(__dirname, '..', 'server.js'), path.join(tmpDir, 'server.js'));

  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_URL: BASE,
      NODE_ENV: 'development',
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      // iyzico/Resend anahtarları kasıtlı olarak boş: ödeme/e-posta gerektiren
      // testler yerine, anahtar yokken sistemin düzgün 503/dev-log ile
      // davrandığını doğruluyoruz.
      IYZICO_API_KEY: '',
      IYZICO_SECRET_KEY: '',
      RESEND_API_KEY: '',
      // server.js izole edilmiş bir geçici klasöre kopyalanıp oradan çalıştırılıyor,
      // o klasörde kendi node_modules'ü yok. NODE_PATH ile asıl projenin
      // node_modules'ünü ek bir arama yolu olarak veriyoruz ki require('@libsql/client')
      // çözümlenebilsin.
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
    },
    stdio: 'pipe',
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (d) => { stderrOutput += d.toString(); });

  // Sunucu ayağa kalkana kadar bekle (en fazla ~5 sn)
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const r = await fetch(BASE + '/api/auth/csrf');
      if (r.ok) ready = true;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!ready) throw new Error(`Test sunucusu zamanında başlamadı.\n--- stderr ---\n${stderrOutput}`);
});

test.after(async () => {
  if (serverProcess) {
    await new Promise((resolve) => {
      serverProcess.once('exit', resolve);
      serverProcess.kill();
      // Süreç bir saniye içinde kapanmazsa yine de devam et.
      setTimeout(resolve, 1000);
    });
  }
  // Windows'ta süreç kapandıktan hemen sonra bile SQLite dosyaları kısa süre
  // kilitli kalabilir (EPERM/EBUSY). rmSync'in yerleşik retry mekanizması
  // bunu birkaç deneme ile kendiliğinden aşar.
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Geçici klasör silinemese bile testlerin sonucunu etkilemez;
      // işletim sistemi onu zamanla kendisi temizler.
    }
  }
});

// ---- testler ---------------------------------------------------------------

test('CSRF token endpoint bir token döner', async () => {
  const jar = makeJar();
  const token = await getCsrf(jar);
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
});

test('CSRF token olmadan state-değiştiren istek reddedilir', async () => {
  const jar = makeJar();
  await getCsrf(jar); // çerezi al ama header'a koyma
  const { status, data } = await req(jar, 'POST', '/api/auth/register', {
    name: 'Test Kullanıcı', email: 'csrf-yok@example.com', password: 'sifre1234',
  });
  assert.equal(status, 403);
  assert.match(data.error, /[Gg]üvenlik/);
});

test('kısa şifreyle kayıt reddedilir', async () => {
  const jar = makeJar();
  const token = await getCsrf(jar);
  const { status, data } = await req(jar, 'POST', '/api/auth/register',
    { name: 'Test', email: 'kisasifre@example.com', password: '123' },
    { 'X-CSRF-Token': token });
  assert.equal(status, 400);
  assert.ok(data.error);
});

test('kayıt + giriş + /api/auth/me uçtan uca çalışır', async () => {
  const jar = makeJar();
  const token = await getCsrf(jar);
  const email = `kullanici-${Date.now()}@example.com`;

  const reg = await req(jar, 'POST', '/api/auth/register',
    { name: 'Elif Test', email, password: 'guclu-sifre-1' },
    { 'X-CSRF-Token': token });
  assert.equal(reg.status, 201);

  const me = await req(jar, 'GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.email, email);

  // aynı e-posta ile tekrar kayıt olunamaz
  const dup = await req(jar, 'POST', '/api/auth/register',
    { name: 'Elif Test', email, password: 'guclu-sifre-1' },
    { 'X-CSRF-Token': token });
  assert.equal(dup.status, 400);
});

test('yanlış şifreyle giriş 401 ve anlamlı bir hata döner', async () => {
  const jar = makeJar();
  const token = await getCsrf(jar);
  const email = `giris-${Date.now()}@example.com`;
  await req(jar, 'POST', '/api/auth/register', { name: 'T', email, password: 'dogru-sifre-1' }, { 'X-CSRF-Token': token });
  await req(jar, 'POST', '/api/auth/logout', undefined, { 'X-CSRF-Token': token });

  const { status, data } = await req(jar, 'POST', '/api/auth/login',
    { email, password: 'yanlis-sifre' }, { 'X-CSRF-Token': token });
  assert.equal(status, 401);
  assert.ok(data.error);
});

test('/api/catalog ürünleri stok bilgisiyle birlikte döner', async () => {
  const jar = makeJar();
  const { status, data } = await req(jar, 'GET', '/api/catalog');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.products) && data.products.length > 0);
  for (const p of data.products) {
    assert.equal(typeof p.stock, 'number');
    assert.ok(p.stock >= 0);
  }
});

test('geçerli kupon kodu indirim uygular, geçersiz kod reddedilir', async () => {
  const jar = makeJar();
  const token = await getCsrf(jar);

  const ok = await req(jar, 'POST', '/api/coupons/validate', { code: 'WELCOME10', amount: 1000 }, { 'X-CSRF-Token': token });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.percentOff, 10);
  assert.equal(ok.data.discount, 100);

  const bad = await req(jar, 'POST', '/api/coupons/validate', { code: 'YOKBOYLEKOD', amount: 1000 }, { 'X-CSRF-Token': token });
  assert.equal(bad.status, 400);
});

test('iyzico anahtarları yokken ödeme başlatma 503 döner (sunucu çökmüyor)', async () => {
  const jar = makeJar();
  const token = await getCsrf(jar);
  const { status, data } = await req(jar, 'POST', '/api/payment/initialize', {
    items: [{ id: 1, qty: 1 }], email: 'a@b.com', identityNumber: '11111111110',
    name: 'A', surname: 'B', address: 'x', city: 'x', zipCode: '34000', gsmNumber: '5551112233',
  }, { 'X-CSRF-Token': token });
  assert.equal(status, 503);
  assert.ok(data.error);
});

test('admin: yanlış bilgiyle giriş 401 ve gerçek hata mesajını döner (genel "oturum gerekli" değil)', async () => {
  const jar = makeJar();
  const token = await getCsrf(jar);
  const { status, data } = await req(jar, 'POST', '/api/admin/login',
    { email: ADMIN_EMAIL, password: 'yanlis' }, { 'X-CSRF-Token': token });
  assert.equal(status, 401);
  assert.match(data.error, /hatalı/i);
});

test('admin: doğru bilgiyle giriş yapılabilir ve korumalı uçlara erişilebilir', async () => {
  const jar = makeJar();
  const token = await getCsrf(jar);

  const login = await req(jar, 'POST', '/api/admin/login',
    { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { 'X-CSRF-Token': token });
  assert.equal(login.status, 200);

  const inv = await req(jar, 'GET', '/api/admin/inventory');
  assert.equal(inv.status, 200);
  assert.ok(Array.isArray(inv.data.inventory));
});

test('admin uçlarına girişsiz erişim 401 döner', async () => {
  const jar = makeJar();
  const { status } = await req(jar, 'GET', '/api/admin/inventory');
  assert.equal(status, 401);
});

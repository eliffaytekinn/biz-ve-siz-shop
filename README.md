# biz ve siz — full-stack takı mağazası

Bu paket Node.js 22+ ile çalışan, SQLite kullanan ve iyzico Checkout Form ile gerçek ödeme akışına hazır bir mağaza uygulamasıdır.

## Çalıştırma

1. Node.js 22+ kurun.
2. Bu klasörde `.env.example` dosyasını `.env` olarak kopyalayın ve gerçek değerleri girin.
3. `npm start` veya `node server.js` çalıştırın.
4. Tarayıcıda `http://localhost:3000` açın.
5. Yönetim paneli: `http://localhost:3000/admin`

> `localhost:3000` başka bir Node süreci tarafından kullanılıyorsa ikinci kez `node server.js` çalıştırmayın. Gerekirse `taskkill /F /IM node.exe` ile eski süreci kapatıp yeniden başlatın.

## Güvenlik

- POST state-changing API'lerde double-submit CSRF cookie + `X-CSRF-Token` kontrolü vardır.
- Giriş, kayıt, ödeme, iletişim, kupon ve admin girişlerinde IP tabanlı rate limit vardır.
- CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy ve HTTPS'te HSTS header'ları vardır.
- Session ve admin-session temizliği periyodik yapılır.
- Şifreler scrypt ile hashlenir; düz metin saklanmaz.
- T.C. Kimlik No için 11 hane kontrolüne ek olarak checksum algoritması uygulanır.
- Sunucu fiyatları kendi ürün kataloğundan hesaplar; istemciden gelen fiyatlara güvenmez.
- Ödeme başlatılırken stok transaction içinde rezerve edilir; iyzico başlatması başarısız olursa veya ödeme başarısız/expired olursa stok geri bırakılır.
- Statik dosyalar asenkron `fs.promises.stat` ile servis edilir ve görseller için uzun süreli cache kullanılır.

## Stok

`inventory` tablosu sunucu tarafındaki gerçek stok kaynağıdır. Ürünler ve katmanlar başlangıç stoklarıyla otomatik oluşturulur. Sipariş ödeme başlatırken stok rezerve edilir.

## Sipariş geçmişi

Giriş yapan kullanıcı `Hesabım` içinden kendi siparişlerini ve durumlarını görebilir. API: `GET /api/orders`.

## E-posta

Resend yapılandırılırsa:
- kayıt sonrası e-posta doğrulama,
- şifre sıfırlama,
- ödeme sonrası müşteriye sipariş e-postası,
- mağaza sahibine yeni sipariş bildirimi,
- iletişim / özel sipariş bildirimi
çalışır.

`REQUIRE_EMAIL_VERIFICATION=true` ile doğrulama zorunlu olur. Yerel test için `false` kullanılabilir.

## Admin

`/admin` basit şifre korumalı yönetim panelidir. Siparişleri `PAID / REVIEW / FAILED` filtreleriyle, talepleri ve stokları gösterir. Admin bilgileri `.env` içindeki `ADMIN_EMAIL` ve `ADMIN_PASSWORD` ile belirlenir.

## Kupon

Örnek `WELCOME10` kuponu %10 indirim için seed edilir. Kupon doğrulama ve indirim sunucu tarafında yapılır; ödeme toplamı da sunucu tarafından yeniden hesaplanır.

## Testler ve CI

Hiçbir ek pakete gerek yok — Node.js'in yerleşik test çalıştırıcısı kullanılıyor.

```
npm test
```

`test/server.test.js`, `server.js`'i ayrı bir geçici klasörde, ayrı bir portta gerçek bir alt süreç olarak başlatıp gerçek HTTP istekleriyle uçtan uca doğrular: CSRF koruması, kayıt/giriş akışı, kupon doğrulama, stoklu katalog, iyzico anahtarı yokken düzgün 503 dönmesi ve admin girişi (hem doğru hem yanlış bilgilerle).

`.github/workflows/ci.yml`, her `push` ve `pull request`'te `node --check server.js` ile sözdizimini ve `npm test` ile test paketini otomatik çalıştırır.

## SEO / Sosyal paylaşım

- `index.html` başında meta açıklama, Open Graph ve Twitter Card etiketleri var (paylaşıldığında sosyal medyada başlık/açıklama/görsel doğru görünür). `SENIN-DOMAININ.com` ve `assets/og-cover.jpg` kısımlarını gerçek domaininiz ve gerçek bir paylaşım görseliyle değiştirin.
- `admin.html`'e `noindex, nofollow` eklendi — admin paneli arama motorlarında hiç görünmez.
- `robots.txt`, `/admin` ve `/api/` yollarını tarayıcılara kapatıp geri kalan siteyi açık bırakır, `sitemap.xml`'e işaret eder.
- `sitemap.xml` şu an tek bir sayfa (anasayfa) listeliyor; yeni statik sayfa eklerseniz buraya da ekleyin. İçindeki domaini de güncelleyin.

## Mimari kararlar (CV/portfolyo notu)

- **Sıfır harici bağımlılık:** Node 22'nin yerleşik `node:sqlite`, `node:http`, `node:crypto` ve `node:test` modülleri kullanıldı; `npm install` gerekmiyor.
- **Sunucu taraflı fiyat/stok doğrulama:** İstemciden gelen fiyata güvenilmiyor, sepet tutarı ve stok her seferinde sunucuda yeniden hesaplanıyor.
- **Stok rezervasyonu transaction içinde:** Ödeme başlatılırken stok `BEGIN IMMEDIATE` ile rezerve ediliyor, ödeme başarısız/zaman aşımına uğrarsa otomatik geri bırakılıyor — böylece aynı üründen aşırı satış (overselling) riski engelleniyor.
- **CSRF:** Double-submit cookie deseni (`bvs_csrf` çerezi + `X-CSRF-Token` header'ı) kullanılıyor.
- **Rate limiting:** IP + uç nokta bazlı, bellek içi pencere sayaçlarıyla (giriş, kayıt, ödeme, admin girişi vb. için ayrı limitler).

## Gerçek ödeme

Canlı iyzico ödemesi için gerçek API anahtarları, canlı domain ve HTTPS gerekir. `APP_URL`, iyzico callback URL'si olarak kullanılacağı için internete erişilebilir olmalıdır.

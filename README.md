# TuneCord

TuneCord, YouTube ve YouTube Music'te dinlediğin parçayı yerel masaüstü uygulamasına aktarır ve Discord'da **Listening / Dinliyor** Rich Presence olarak gösterir.

## Özellikler

- YouTube ve YouTube Music parça algılama
- Şarkı kapağını masaüstü uygulamasında ve Discord Presence'ta gösterme
- Chromium ve Firefox tabanlı tarayıcı desteği
- Tüm şarkılar veya yalnızca seçili playlistler
- Tarayıcı ile uygulama arasında Native Messaging
- Google OAuth yok
- Ayarlar için ayrı **Kaydet** düğmesi yok; değişiklikler anında kaydedilir
- Windows ile otomatik başlatma ve tray desteği
- Düşük bellekli native tray backend: pencere kapalıyken Electron çalışmaz

## Düşük RAM mimarisi

TuneCord v1.4 ile Discord RPC, tray, tarayıcı algılama ve ayar saklama küçük bir native Rust arka plan servisinde çalışır. Electron yalnızca ayarlar penceresini açtığında başlatılır; pencereyi kapattığında Electron tamamen kapanır ve tray'de sadece native servis kalır.

Tarayıcı eklentisi TuneCord'a doğrudan WebSocket açmaz. Chromium ve Firefox'un Native Messaging sistemi `tunecord-native-host.exe` ile konuşur; native host da arka plan servisine yalnızca `127.0.0.1` üzerinde kısa ömürlü yerel HTTP istekleri yollar. Kalıcı localhost socket tutulmadığı için tarayıcı güvenlik değişikliklerinden ve stale TCP bağlantılarından daha az etkilenir.

Hedef, sistem ve Windows sürümüne göre değişmekle birlikte tray kullanımını yaklaşık **5–15 MB RAM** bandına yaklaştırmaktır. Ayarlar penceresi açıkken Chromium tabanlı Electron süreci nedeniyle RAM kullanımı geçici olarak daha yüksek olur.

## Kurulum

GitHub Releases bölümündeki `TuneCord.exe` dosyasını çalıştır. İlk açılışta TuneCord bilgisayarındaki desteklenen tarayıcıları tarar ve kullanacağın tarayıcıyı seçtirir.

### Chromium

Chrome, Brave, Edge, Vivaldi, Opera ve diğer Chromium tabanlı tarayıcılarda:

1. TuneCord kurulumunda tarayıcını seç.
2. **Dosyaları hazırla** düğmesine bas.
3. TuneCord'un gösterdiği eklenti klasörünü not et.
4. Seçtiğin tarayıcının eklentiler sayfasını kendin aç veya TuneCord'daki **Eklenti sayfasını aç** düğmesini kullan.
5. **Geliştirici modu / Developer mode** seçeneğini aç.
6. **Paketlenmemiş öğe yükle / Load unpacked** düğmesine bas.
7. TuneCord'un gösterdiği `%APPDATA%\TuneCord\extension` klasörünü seç.
8. YouTube veya YouTube Music sekmesini yenile.

**Dosyaları hazırla** düğmesi tarayıcıyı otomatik açmaz.

### Firefox

Firefox, Firefox Developer Edition, LibreWolf, Waterfox, Floorp, Zen Browser ve diğer Firefox tabanlı tarayıcılarda:

1. TuneCord kurulumunda tarayıcını seç.
2. **Dosyaları hazırla** düğmesine bas.
3. `about:debugging#/runtime/this-firefox` sayfasını kendin aç veya TuneCord'daki **Eklenti sayfasını aç** düğmesini kullan.
4. **Load Temporary Add-on / Geçici eklenti yükle** seçeneğine bas.
5. TuneCord'un gösterdiği `%APPDATA%\TuneCord\extension-firefox\manifest.json` dosyasını seç.
6. YouTube veya YouTube Music sekmesini yenile.

> Standart Firefox sürümleri imzasız eklentileri kalıcı olarak kurmaz. Kalıcı kurulum için Mozilla tarafından imzalanmış bir XPI gerekir.

## Discord Application ID

Varsayılan Application ID:

```text
1545256357727576124
```

İstersen kendi Discord uygulamanın Application ID'sini kullanabilirsin. **Standarta dön** düğmesi varsayılan ID'yi geri yükler.

## Otomatik kayıt

Presence aç/kapat, Windows ile başlatma, Discord Application ID, playlist modu ve playlist seçimleri değiştirildiği anda kaydedilir.

## Yerel bağlantı

Eklenti ile TuneCord arasındaki ana taşıma katmanı **Native Messaging**'dir. Native Messaging host yalnızca aynı bilgisayardaki TuneCord native servisine `127.0.0.1:37645` üzerinden kısa ömürlü HTTP istekleri yapar. Dış ağa dinleyen bir servis yoktur.

## Google OAuth yok

TuneCord `chrome.identity`, Google OAuth veya Google API anahtarı kullanmaz. Playlistler, tarayıcıda zaten açık olan YouTube oturumunun verisinden okunur.

## Gizlilik

- Video veya ses kaydedilmez.
- Yalnızca parça meta verisi, playlist ad/ID listesi ve TuneCord ayarları kullanılır.
- Native Messaging yalnızca yerel TuneCord host'una bağlanır.
- Native servis yalnızca `127.0.0.1` üzerinde dinler.

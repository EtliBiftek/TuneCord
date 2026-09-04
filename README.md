# TuneCord

TuneCord, YouTube ve YouTube Music'te dinlediğin parçayı yerel masaüstü uygulamasına aktarır ve Discord'da **Listening / Dinliyor** Rich Presence olarak gösterir.

## Özellikler

- YouTube ve YouTube Music parça algılama
- Şarkı kapağını masaüstü uygulamasında ve Discord Presence'ta gösterme
- Chromium ve Firefox tabanlı tarayıcı desteği
- Tüm şarkılar veya yalnızca seçili playlistler
- Yerel WebSocket bağlantısı
- Google OAuth yok
- Ayarlar için ayrı **Kaydet** düğmesi yok; değişiklikler anında kaydedilir
- Windows ile otomatik başlatma ve tray desteği

## Kurulum

GitHub Releases bölümündeki `TuneCord.exe` dosyasını çalıştır. İlk açılışta TuneCord bilgisayarındaki desteklenen tarayıcıları tarar ve kullanacağın tarayıcıyı seçtirir.

### Chromium

Chrome, Brave, Edge, Vivaldi, Opera ve diğer Chromium tabanlı tarayıcılarda:

1. TuneCord kurulumunda tarayıcını seç.
2. **Dosyaları hazırla** düğmesine bas.
3. Tarayıcının eklentiler sayfasını aç (`chrome://extensions/`, `brave://extensions/` vb.).
4. **Geliştirici modu / Developer mode** seçeneğini aç.
5. **Paketlenmemiş öğe yükle / Load unpacked** düğmesine bas.
6. TuneCord'un gösterdiği `%APPDATA%\TuneCord\extension` klasörünü seç.
7. YouTube veya YouTube Music sekmesini yenile.

### Firefox

Firefox, Firefox Developer Edition, LibreWolf, Waterfox, Floorp, Zen Browser ve diğer Firefox tabanlı tarayıcılarda:

1. TuneCord kurulumunda tarayıcını seç.
2. **Dosyaları hazırla** düğmesine bas.
3. `about:debugging#/runtime/this-firefox` sayfasını aç.
4. **Load Temporary Add-on / Geçici eklenti yükle** seçeneğine bas.
5. TuneCord'un gösterdiği `%APPDATA%\TuneCord\extension-firefox\manifest.json` dosyasını seç.
6. YouTube veya YouTube Music sekmesini yenile.

> Standart Firefox sürümleri imzasız eklentileri kalıcı olarak kurmaz. Bu nedenle yerel geliştirme sürümü Firefox yeniden başlatıldığında tekrar yüklenmelidir. Kalıcı kurulum için Mozilla tarafından imzalanmış bir XPI gerekir.

## Discord Application ID

TuneCord varsayılan olarak şu Application ID ile gelir:

```text
1545256357727576124
```

İstersen kendi Discord uygulamanın Application ID'sini kullanabilirsin. Masaüstü uygulamasında ve eklenti ayarlarında **Standarta dön** düğmesi varsayılan ID'yi geri yükler.

## Otomatik kayıt

Presence aç/kapat, Windows ile başlatma, Discord Application ID, playlist modu ve playlist seçimleri değiştirildiği anda kaydedilir. Application ID geçerli hale geldiğinde kısa bir debounce sonrasında yeni Discord bağlantısı otomatik başlatılır.

## Yerel WebSocket

Eklenti ve masaüstü uygulaması şu yerel adres üzerinden haberleşir:

```text
ws://127.0.0.1:37645/ws
```

Bağlantı yalnızca loopback arayüzünde dinler. Chromium ve Firefox eklentilerinin sabit extension ID'leri doğrulanır ve eşleşme token'ı yerel olarak saklanır.

## Google OAuth yok

TuneCord `chrome.identity`, Google OAuth veya Google API anahtarı kullanmaz. Playlistler, tarayıcıda zaten açık olan YouTube oturumunun verisinden okunur.

## Gizlilik

- Video veya ses kaydedilmez.
- Yalnızca parça meta verisi, playlist ad/ID listesi ve TuneCord ayarları kullanılır.
- WebSocket dış ağa açılmaz; yalnızca `127.0.0.1` üzerinde çalışır.

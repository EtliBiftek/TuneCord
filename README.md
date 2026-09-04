# TuneCord

TuneCord, YouTube ve YouTube Music'te çalan parçayı yerel masaüstü uygulamasına aktarır ve Discord'da **Listening / Dinliyor** Rich Presence olarak gösterir.

## Özellikler

- YouTube ve YouTube Music parça algılama
- Discord Rich Presence
- Şarkının YouTube kapak görselini Discord Rich Presence'ta gösterme
- Tüm şarkılar veya yalnızca seçili playlistler
- Windows ile otomatik başlatma
- Tray desteği
- Google OAuth yok
- Yerel WebSocket bağlantısı
- Uygulama ve eklenti ayarlarında **Kaydet** düğmesi yok; değişiklikler anında otomatik kaydedilir
- Discord IPC bağlantısı paralel pipe taraması ve otomatik retry ile hızlı kurulur

## Kurulum

GitHub Releases bölümünden yalnızca `TuneCord.exe` dosyasını indirip çalıştır.

İlk açılışta TuneCord:

1. Bilgisayardaki Chromium tabanlı tarayıcıları tarar.
2. Kullanacağın tarayıcıyı seçmeni ister.
3. Eklenti dosyalarını `%APPDATA%\TuneCord\extension` klasörüne hazırlar.
4. Tarayıcının eklentiler sayfasını açmaya çalışır.
5. Güvenlik nedeniyle son **Load unpacked / Paketlenmemiş öğe yükle** onayını kullanıcı tamamlar.

### Brave

1. TuneCord'da **Brave** seç.
2. **Dosyaları hazırla** düğmesine bas.
3. Brave'de `brave://extensions/` adresini aç.
4. Sağ üstten **Developer mode / Geliştirici modu** seçeneğini aç.
5. **Load unpacked / Paketlenmemiş öğe yükle** düğmesine bas.
6. `%APPDATA%\TuneCord\extension` klasörünü seç.
7. YouTube veya YouTube Music sekmesini yenile.

### Google Chrome

Google Chrome güncel sürümlerde komut satırından kalıcı unpacked eklenti kurulumunu desteklemez. TuneCord bu yüzden eklentiyi zorla kurmaya çalışmaz.

1. TuneCord'da **Google Chrome** seç.
2. **Dosyaları hazırla** düğmesine bas.
3. Chrome'da `chrome://extensions/` adresini aç.
4. Sağ üstten **Developer mode / Geliştirici modu** seçeneğini aç.
5. **Load unpacked / Paketlenmemiş öğe yükle** düğmesine bas.
6. `%APPDATA%\TuneCord\extension` klasörünü seç.
7. YouTube veya YouTube Music sekmesini yenile.

Diğer Chromium tabanlı tarayıcılarda da aynı **Load unpacked** yöntemi kullanılır.

## Otomatik kayıt

TuneCord'da ayrı bir **Kaydet** düğmesi yoktur.

Aşağıdaki değişiklikler yapıldığı anda kaydedilir ve bağlı arayüzlere iletilir:

- Discord'da göster aç/kapat
- Windows ile başlat
- Discord Application ID
- Tüm şarkılar / seçili playlistler modu
- Playlist seçimleri

Application ID yazılırken geçerli 17–22 haneli değer oluştuğunda kısa bir debounce sonrasında otomatik kaydedilir ve Discord bağlantısı hemen yeniden başlatılır.

## WebSocket bridge

Eklenti ile masaüstü uygulaması yerel WebSocket üzerinden konuşur:

```text
ws://127.0.0.1:37645/ws
```

- Bağlantı yalnızca loopback (`127.0.0.1`) üzerinde dinler.
- Sabit manifest anahtarı sayesinde TuneCord eklentisinin extension ID'si sabittir ve WebSocket eşleşmesinde doğrulanır.
- Eklenti rastgele oluşturulan eşleşme token'ı ile doğrulanır.
- Ayar ve durum değişiklikleri WebSocket üzerinden anında push edilir.
- Eklenti bağlantıyı canlı tutmak için heartbeat gönderir.

## Google OAuth yok

TuneCord Google OAuth, Google API anahtarı veya `chrome.identity` kullanmaz.

Playlistler, tarayıcıda zaten açık olan YouTube oturumunun `/feed/playlists` verisinden salt okunur şekilde alınır.

- Google token'ı alınmaz veya saklanmaz.
- Şifre okunmaz.
- Eklentinin web erişimi yalnızca YouTube ve YouTube Music içindir.

## Discord ayarı

1. Discord Developer Portal'da bir uygulama oluştur.
2. **General Information → Application ID** değerini TuneCord'a yaz.
3. Değer geçerli hale geldiğinde otomatik kaydedilir.
4. Discord masaüstü uygulamasını açık tut.

TuneCord `discord-ipc-0` ile `discord-ipc-9` pipe'larını paralel dener. İlk gerçek `READY` yanıtını veren bağlantıyı kullanır; ilk denemede yanıt gelmezse kısa aralıklarla otomatik yeniden dener. Bu sayede tek bir 5 saniyelik `READY` timeout'una takılı kalmaz.

Web Discord masaüstü IPC sağlamadığı için desteklenmez.

## Şarkı kapak görseli

YouTube video ID'sinden alınan kapak görseli (`i.ytimg.com`) hem TuneCord uygulamasındaki **Şu an çalıyor** kartında hem de Discord Rich Presence'ın büyük görsel alanında kullanılır. Discord harici görsel URL'lerini Rich Presence asset'i olarak destekler.

## Playlist filtresi

Eklenti ayarlarında **YouTube oturumundan yenile** düğmesi playlistlerini getirir.

- **Tüm şarkılar:** Her aktif YouTube/YouTube Music parçası gösterilir.
- **Seçili playlistler:** Yalnızca URL'deki `list=` değeri seçtiğin playlistlerden biriyle eşleşirse Presence gönderilir.

Playlist checkbox'ları seçildiği anda otomatik kaydedilir.

## Yerel çalışma ve gizlilik

- WebSocket yalnızca `127.0.0.1:37645` üzerinde dinler.
- Video veya ses kaydedilmez.
- Yalnızca parça meta verisi, playlist ad/ID listesi ve kullanıcı ayarları saklanır.
- Eşleşme token'ı yerel olarak saklanır ve uygulamadan sıfırlanabilir.

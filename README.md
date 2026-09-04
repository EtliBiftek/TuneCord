# TuneCord

TuneCord, YouTube ve YouTube Music'te çalan parçayı yerel Windows uygulamasına aktarır ve Discord'da **Listening / Dinliyor** Rich Presence olarak gösterir. Electron veya arka planda çalışan bir web arayüzü kullanmaz; uygulama doğrudan Win32 C++ ile yazılmıştır.

## Özellikler

- YouTube ve YouTube Music için başlık, sanatçı, süre, oynatma durumu ve playlist algılama
- Discord Presence'i uygulamadan, tray menüsünden veya eklenti popup'ından kapatma/açma
- Tüm şarkıları ya da yalnızca seçilen playlistleri gösterme
- Google hesabından playlistleri salt okunur YouTube Data API izniyle getirme
- Windows açılışında otomatik ve doğrudan tray'de başlama
- Dış bağımlılığı olmayan native `TuneCord.exe`
- Yalnızca `127.0.0.1:37645` üzerinde dinleyen, rastgele anahtarlı local bridge

## 1. Windows uygulamasını kur

Hazır GitHub Actions paketinde PowerShell açıp şunu çalıştır:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Kaynak koddan derlemek için Visual Studio 2022'nin **Desktop development with C++** bileşeni kuruluysa `Build.ps1` çalıştır. Alternatif olarak `TuneCord.sln` dosyasını açıp `Release | x64` build al. Çıktı `dist\TuneCord.exe` olur.

## 2. Discord Application ID oluştur

1. [Discord Developer Portal](https://discord.com/developers/applications) üzerinden **New Application** de ve adını `TuneCord` yap.
2. **General Information → Application ID** değerini kopyala.
3. `TuneCord.exe` içindeki **Discord Application ID** alanına yapıştırıp **Kaydet** de.
4. Discord masaüstü uygulamasının açık olduğundan emin ol. Tarayıcı Discord'u IPC sağlamaz.

Uygulama Discord IPC'ye `ActivityType.Listening` (`type: 2`) gönderir. Bazı Discord istemci sürümleri üçüncü taraf custom activity türünün etiketini kendi arayüzünde farklı gösterebilir; parça ve sanatçı bilgisi yine Presence içinde kalır.

## 3. Playlistleri getir

En kolay yöntem eklenti ayarlarında **YouTube oturumundan getir** düğmesidir. Eklenti, tarayıcıda zaten açık olan YouTube hesabının `/feed/playlists` verisini okur; şifrene veya Google token'ına erişmez. Bu yöntem Chrome, Brave ve Edge gibi Chromium tarayıcılarında ek OAuth kurulumu istemez.

YouTube sayfası biçimini değiştirirse veya hesabında çok fazla playlist varsa resmi API yöntemini kullanabilirsin:

### İsteğe bağlı: Google OAuth'u ayarla

Google, başka birinin adına gizlice OAuth kimliği dağıtmaya izin vermediği için kendi ücretsiz Client ID'ni oluşturmalısın. Şifre veya client secret gerekmez.

Sabit extension ID:

```text
mfhiohlcbedfhemkommfailjjfkdfobe
```

1. [Google Cloud Console](https://console.cloud.google.com/) içinde bir proje oluştur.
2. **APIs & Services → Library** bölümünden **YouTube Data API v3**'ü etkinleştir.
3. **OAuth consent screen** oluştur. Uygulama Testing modundaysa kendi Google e-postanı test user olarak ekle.
4. **Credentials → Create credentials → OAuth client ID → Chrome Extension** seç.
5. Item ID alanına yukarıdaki extension ID'yi gir ve oluşturulan Client ID'yi kopyala.
6. Proje ana klasöründe şu komutu çalıştır:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Configure-GoogleOAuth.ps1 -ClientId "BURAYA_CLIENT_ID.apps.googleusercontent.com"
```

7. Chromium'da `chrome://extensions` aç, Developer mode'u aç, **Load unpacked / Paketlenmemiş öğe yükle** deyip `extension` klasörünü seç.

Chrome'un resmi Identity akışı için OAuth Client ID manifestte bulunmak zorundadır. İstenen tek kapsam `youtube.readonly`; TuneCord playlist ekleyemez, değiştiremez veya silemez.

## 4. Kullanım

1. Discord masaüstü uygulamasını ve `TuneCord.exe`yi aç.
2. Eklentinin **Ayarlar** ekranında **YouTube oturumundan getir**e bas. Gerekirse resmi API için **Google OAuth ile getir**i kullan.
3. **Tüm şarkılar** veya **Yalnızca seçtiklerim** modunu seç; gerekiyorsa playlistleri işaretle ve kaydet.
4. YouTube ya da YouTube Music'te bir parça başlat.

Playlist modu, adres çubuğundaki gerçek YouTube `list=` kimliğini karşılaştırır. Playlist dışından açılan tekil parçalar seçili-playlist modunda Discord'a gönderilmez.

## Gizlilik ve kaynak kullanımı

- Google access token'ı uygulamaya gitmez; Chromium'un `chrome.identity` token cache'inde kalır.
- Uygulama yalnızca parça bilgisi, ayarlar ve playlist ad/ID listesini `%LOCALAPPDATA%\TuneCord\config.json` içinde tutar.
- Bridge tüm ağ arayüzlerine değil yalnızca loopback'e bind olur. API çağrıları uygulamanın ürettiği eşleşme anahtarını ister.
- Video/audio verisi okunmaz veya kaydedilmez.
- Presence güncellemesi yalnızca parça değişince yapılır; boşta sürekli Discord mesajı göndermez.

## Sorun giderme

- **Eklenti uygulamayı görmüyor:** `TuneCord.exe`yi açıp popup'ta **Yeniden bağlan**a bas. `37645` portunu başka uygulamanın kullanmadığını kontrol et.
- **Discord bekleniyor:** Web Discord değil masaüstü Discord açık olmalı. Application ID'yi tekrar kontrol et.
- **Google OAuth hatası:** Extension ID'nin `mfhiohlcbedfhemkommfailjjfkdfobe` olduğuna, YouTube Data API v3'ün açık olduğuna ve hesabının test user listesinde bulunduğuna bak.
- **Seçili playlistte görünmüyor:** Oynatılan URL'de `list=...` bulunmalı ve bu ID seçilen playlistle aynı olmalı.

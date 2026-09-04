# TuneCord

TuneCord, YouTube ve YouTube Music'te çalan parçayı yerel Electron uygulamasına aktarır ve Discord'da **Listening / Dinliyor** Rich Presence olarak gösterir.

## Kurulum

GitHub Releases bölümünden yalnızca `TuneCord.exe` dosyasını indirip çalıştır.

İlk açılışta TuneCord kurulum sihirbazı:

1. Bilgisayardaki Chromium tabanlı tarayıcıları (Brave, Chrome, Edge, Vivaldi, Opera/Opera GX, Chromium) tarar.
2. Kullanacağın tarayıcıyı seçmeni ister.
3. TuneCord eklentisinin gerekli olduğunu açıkça belirtir ve kurulum için onay ister.
4. Onay verirsen eklentiyi yerel TuneCord klasörüne hazırlar ve seçtiğin tarayıcıyı eklenti yüklenmiş şekilde açar.

Chromium güvenlik politikaları bazı tarayıcı sürümlerinde ilk yüklemede ek bir tarayıcı onayı gösterebilir. TuneCord bunun dışındaki dosya hazırlama ve başlatma adımlarını otomatik yapar.

## Google OAuth yok

TuneCord artık Google OAuth, Google API anahtarı veya `chrome.identity` kullanmaz. Playlistler, tarayıcıda zaten açık olan YouTube oturumunun `/feed/playlists` verisinden salt okunur şekilde alınır.

- Google token'ı alınmaz veya saklanmaz.
- Şifre okunmaz.
- İstenen tek web erişimi YouTube / YouTube Music ve yerel `127.0.0.1:37645` bridge'idir.

## Discord ayarı

1. Discord Developer Portal'da bir uygulama oluştur.
2. **General Information → Application ID** değerini TuneCord'a gir.
3. Discord masaüstü uygulamasını açık tut.

TuneCord gerçek Discord IPC `READY` yanıtını bekler ve ardından `SET_ACTIVITY` gönderir. Web Discord, masaüstü IPC sağlamadığı için desteklenmez.

## Playlist filtresi

Eklenti ayarlarında **YouTube oturumundan yenile** düğmesi playlistlerini getirir. Ardından:

- **Tüm şarkılar**: her aktif YouTube/YouTube Music parçasını gösterir.
- **Seçili playlistler**: yalnızca URL'deki `list=` değeri seçtiğin playlistlerden biriyle eşleşirse Presence gönderir.

## Yerel çalışma ve gizlilik

- Bridge yalnızca `127.0.0.1:37645` üzerinde dinler.
- Eklenti ve uygulama rastgele oluşturulan bir eşleşme anahtarıyla konuşur.
- Video veya ses kaydedilmez.
- Yalnızca parça meta verisi, playlist ad/ID listesi ve kullanıcı ayarları saklanır.

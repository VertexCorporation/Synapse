# HuggingFace offline keşif incelemesi — 8 Eylül 2026

## Kapsam

Yalnızca dinamik offline keşif, GGUF varyantları, bunların metadata yenilenmesi ve Curator uyumluluğu taşındı. Mevcut OpenRouter/Fal/Cloudflare/Groq/ElevenLabs/Deepgram işlemcileri, fiyat eşikleri, online tier mantığı, fallback, online tekrar ayıklama ve scheduler korunmuştur. Premium sınıflandırması geri getirilmedi. Çalışma başladığında repoda mevcut olan kaydedilmemiş değişiklikler korunmuştur; Git diff bunları da gösterir.

## Gerçek deploy geçmişi

Git'te yalnızca 5 commit mevcut ve hiçbirinde HuggingFace keşfi bulunmuyor. Cloudflare üzerinden son 10 deployun **gerçek kaynak kodu** ayrıca alındı. Aşağıdaki saatler UTC'dir.

| Deploy | Sürüm | HuggingFace davranışı |
|---|---|---|
| 2026-05-17 09:46:07 | `9f2e9f58-b205-47da-93ba-896c65bc756a` | Dinamik keşif + aile/varyant gruplama mevcut |
| 2026-09-07 19:32:38 | `c2c7cfcf-a1e0-455c-b836-3b994313e7e4` | Keşif ve çağrısı kaldırılmış |
| 2026-09-07 20:49:49 | `3eb7c4e0-d2b2-4e4d-8ae7-f0a8a718a08c` | Aynı kod; keşif yok |
| 2026-09-07 21:57:25 | `ddb2800c-fccf-445a-accc-d7eb81c2623e` | Sadece mevcut HF URL'lerine metadata yenileme eklenmiş |
| 2026-09-08 09:06:03 | `fed86895-c9c8-46b9-aa3c-d87ba249e743` | Secret değişimi; aynı metadata kodu |
| 2026-09-08 09:06:08 | `14c0dd64-3ab9-41bb-840f-8bac3f381d7b` | Secret değişimi; aynı metadata kodu |
| 2026-09-08 09:06:12 | `6184021f-64ff-4651-b5c9-a1b72c59d489` | Secret değişimi; aynı metadata kodu |
| 2026-09-08 09:06:15 | `25246859-f7de-478e-986c-a46ea20f30ae` | Secret değişimi; aynı metadata kodu |
| 2026-09-08 09:06:19 | `6f5bc603-ce28-4abc-8c7d-c39eb62a317d` | Secret değişimi; aynı metadata kodu |
| 2026-09-08 09:06:23 | `5c119338-9e6c-4827-aa76-5c2896cad033` | Secret değişimi; aynı metadata kodu |

Toplam 3 farklı kod gövdesi var. Eski bundle içindeki `processing/huggingface.js` bölümü `huggingface-recovered-2026-05-17.txt` dosyasında değiştirilmeden saklandı. Eski bundle'da bölüm 838–1069, sync bağlantısı 1314–1330 satırlarında. Tüm eski bundle'ları geri koymak yeni mimariyi geri alacağından yalnızca ilgili davranış taşındı.

**Sonuç:** “Hiç dinamik HuggingFace syncer yazılmadı” iddiası yanlış. Kodun geçmişte deploy edildiği kanıtlandı. Bu, eski her cron çalışmasının başarıyla model ürettiğini tek başına kanıtlamaz; geçmiş çalışma logları incelenmedi.

Eski istek `expand[]` kullanıyor. Canlı doğrulamada `downloads` alanı yine döndü; alanın eksik olduğu hipotezi doğrulanmadı ve kök neden olarak kabul edilmedi.

8 Eylül incelemesindeki herkese açık katalog: 287 varyant; 245 OpenRouter ve 42 manual. Bağımsız `source: huggingface` kaydı yok. Eski listeye metadata eklenmesi yeni repo keşfi değildir.

## Taşınan davranış ve uyumluluk

- Her mevcut saatlik cron'da Hub API'den indirme sayısına göre 2.000 aday istenir. Elle yazılmış repo listesi veya yayıncı whitelist'i yoktur.
- Eski kalite eşiği korunur: en az 1.000 indirme ve (en az 50 beğeni veya en az 50.000 indirme). Eski isim filtresi de korunur.
- Uygun adaylar beğeni/indirme sayısıyla sıralanır; kaynak kullanımını sınırlamak için en fazla 24 repo ayrıntısı, 6 paralel istekle alınır. Bunlar sabit model kimlikleri değil, config içindeki işlem bütçeleridir. Yorum sayısı kullanılmaz: bulunan eski sistemin ölçütleri geri taşınmıştır.
- Eski sistem repo başına tek tercih edilen quant seçiyordu. Şimdi her bağımsız quant dosyası kendi kimliğiyle varyanttır. Aynı isimde farklı quant tarifleri veya yayıncılar birbirini ezmez.
- Örnek: `Google → Gemma 3 → 12B Instruct (Q4_0)`; `Meta → Llama 3.1 → 8B Instruct (Q4_K_M)`.
- Dosya boyutu `blobs=true` cevabından ölçülür; RAM dosya boyutu + 2.000 MiB tahmini olarak işaretlenir. Bu değer gerçek cihazdaki çalışma belleğinin garantisi değildir.
- Chat payload yapıları eski offline modülden taşındı. Phi-4'e yanlışlıkla Phi-3 formatı atanması taşınmadı. Bu isim temelli seçim eski yaklaşımın sınırlamasını taşır; her yeni mimarinin istemci uyumluluğu bu testlerle doğrulanmış değildir.
- Yeni keşifte gated/private repolar, açıkça text-generation olmayan görevler, projector/MTP/draft/adapter yardımcı dosyaları ve parçalı GGUF'lar atlanır. Mevcut istemci tek indirme URL'si kullandığı için bir shard bağımsız model diye sunulmaz. Mevcut manuel/hybrid linkler korunur.
- API liste hatası veya geçersiz/boş sonuç eski HF kataloğunu korur. Tek repo hatası o reponun eski varyantlarını korur. Blacklist hem repo hem dosya kimliğine uygulanır.
- Keşif online tekrar ayıklamadan sonra birleştirilir. Online/hybrid kayıtlar aynı gösterim anahtarına denk gelseler bile ezilmez.
- Manuel offline kayıtların açıklamaları/çevirileri/visibility alanları kimlikleriyle yeni grup konumuna taşınır. Roleplay kayıtları `Default` yapısında kalır.
- Curator offline save/update aynı gruplamayı kullanır; tekrar eski ID/Default serisini oluşturmaz. Offline olmayan save yolu korunmuştur.
- Yeni HF dosya bilgisi merge sonrasında uygulanır; eski KV boyutu güncel boyutu ezmez. Mevcut manuel/hybrid metadata yenilemesi korunur; yeni keşfedilen repolar ikinci kez indirilmez.

## Doğrulama ve teslim durumu

- `node --test syncer/tests/huggingface.test.js`: **15/15 geçti**. Tüm cron akışı bellek içi KV ve sahte API'lerle çalıştırıldı; standard/fallback, offline ekleme, blacklist, kesinti, quant kimlikleri, Curator ve çeviri koruması doğrulandı.
- Syncer ve Curator: Wrangler `deploy --dry-run` başarılı.
- Gerçek HF API'siyle salt okunur son deneme: 24 seçilen repodan 22'sinde kullanılabilir dosyalar, toplam **222 GGUF varyantı**. Bu, deneme anındaki çıktı; gelecekteki sayı değişebilir.
- Canlı deploy yapılmadı; canlı KV değiştirilmedi.

API referansları: [HuggingFace Hub API](https://huggingface.co/docs/hub/api), [Cloudflare sürüm kaynaklarını okuma](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/).

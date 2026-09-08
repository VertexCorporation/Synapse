# Canlı KV sayımı ve Fal endpoint incelemesi

8 Eylül 2026 20:26 UTC civarında hem herkese açık endpoint hem doğrudan Cloudflare KV `list` anahtarı salt okunur incelendi. İkisinin sürümü de `2026-09-08T20:05:38.501Z` idi. Yeni deploy sonrası ilk cron henüz çalışmamıştı.

| Kaynak | Canlı ana katalog | Son tam senkronizasyon denemesi |
|---|---:|---:|
| OpenRouter | 248 | 263 |
| Fal | 0 | 493 |
| Cloudflare | 0 | 35 |
| Groq | 0 | 14 |
| HuggingFace (source=huggingface) | 0 | 222 |
| ElevenLabs | 0 | 9 |
| Deepgram | 0 | 24 |
| Manual | 42 | 42 |
| Toplam | 290 | 1102 |

Her iki katalogda ayrıca 18 OpenRouter fallback kaydı var. Fallback dahil canlı toplam 308, test toplamı 1120. Bunlar model/varyant kayıtları; benzersiz temel model ailesi sayısı değildir.

Canlıdaki 42 manuel kaydın 18'i offline, 24'ü roleplay. HuggingFace indirme bağlantısı bulunan toplam 35 kayıt var: 18 manuel offline + 17 source=openrouter hibrit. Bu 35 kayıt yukarıdaki sayılara dahildir; ayrıca eklenmez. Önceki daha eski ölçümdeki 12/23 dağılımı bu KV snapshot'ında geçerli değildir.

## Fal

Güncel API 1498 ham endpoint döndürdü. Deploy edilen filtreyi bu ham cevap üzerinde yeniden çalıştırınca 493 farklı endpoint kimliği tekrar üretildi. Hepsi active durumunda.

- Farklı görünen ad: 366.
- Birden fazla endpoint içeren görünen ad: 61.
- Farklı görünen ad + işlem kategorisi: 425. Aynı ad/kategori gruplarında 68 ek endpoint var; bunların hepsinin teknik olarak eşdeğer olduğu kanıtlanmış değildir.
- 423 endpoint API'nin 105 farklı group.key grubunda; 70 endpointte group.key yok. Bunlar da kesin temel model sayısı olarak kullanılamaz.
- Seri dağılımı örnekleri: Flux 78, Kling 77, Wan 62, PixVerse 41. Yalnızca bu dört aile 258 endpoint oluşturuyor.

Örnek çoğalma: Veo 3.1 Fast adı altında text-to-video, image-to-video, first-last-frame-to-video, reference-to-video ve extend-video uçları ayrı sayılıyor. Üretim/düzenleme, fast/turbo/pro, sürüm, çözünürlük ve model boyutu seçenekleri de sayıyı artırıyor.

`fal-ai/flux/schnell` ve `fal-ai/flux-1/schnell` aynı FLUX.1 [schnell] adı ve text-to-image kategorisini taşıyor. API group.key değerleri farklı: flux-1 ve flux-1-fast. Bu aynı temel model için alternatif sunum/çıkarım yollarına işaret eder; yalnızca isim benzerliğiyle bütün uçların eşdeğer kabul edilip silinmesi doğru olmaz.

## Filtrenin sınırı

Kullanıcının asset haritası üretici fallback anahtarları da içeriyor. Mevcut politika bu nedenle `veed/subtitles`, `veed/video-background-removal` ve `google/virtual-try-on` gibi hizmet/işlem uçlarını da üreticileri üzerinden kabul ediyor. Bu kayıtlar haritayla eşleşir fakat ayrı temel model değildir. Asset eşleşmesi, bağımsız model ya da kalite doğrulaması olarak yorumlanmamalıdır.

Katalog daha sade olacaksa model ailesi/sürümü üst kayıt, endpointler bu kaydın görev seçenekleri olarak tutulmalı; aynı modelin alternatif sunum uçları API group bilgisi ve giriş şemaları karşılaştırılarak birleştirilmeli. Temel üretici eşleşmesi yardımcı hizmetlere otomatik geçiş vermemeli. Bu inceleme sırasında üretim filtresi veya deploy değiştirilmedi.

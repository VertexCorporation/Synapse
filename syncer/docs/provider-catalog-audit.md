# Dış kaynak sağlayıcı filtresi — 8 Eylül 2026

Kullanıcının gönderdiği `ModelDefaults.localAssetImageMap` içindeki model aileleri ve üretici fallback anahtarları izin listesine aktarıldı. Karakter kimlikleri ve sanal Cortex kayıtları dış kaynak izinleri sayılmadı. Filtre yalnızca Cloudflare, Deepgram, ElevenLabs ve Fal için geçerlidir; OpenRouter, Groq, manuel ve HuggingFace kaynaklarının kapsamı korunur.

## Gerçek API ve tam senkronizasyon testi

Canlı KV yalnızca okundu; tam deneme bellek içi KV kopyasında çalıştırıldı. Bu tabloda mevcut online tekrar ayıklama ve eski verilerle merge sonrasındaki sayılar var.

| Kaynak | Varyant | Ekte eşleşen anahtarlar |
|---|---:|---|
| cloudflare | 35 | deepseek, flux, gemma, google, llama, meta, microsoft, mistral, nova, nvidia, qwen, stable, whisper |
| deepgram | 24 | nova, whisper |
| elevenlabs | 9 | elevenlabs |
| fal | 493 | bria, bytedance, ernie, flux, gemini, google, gpt-image, ideogram, kling, lyria, meta, microsoft, minimax, nvidia, openai, pixverse, qwen, qwen-image, sdxl, seedvr, stable, stable-audio, veed, veo, wan, xai, z-image |

Toplam: **561** model kimliği. Eşleşmeyen: **0**. Her kaynağın model kimlikleri, üreticisi, serisi, varyantı ve karşılık gelen asset anahtarı `provider-catalog-results.json` dosyasında bulunur.

Cloudflare ham işlemci çıktısı 39, Deepgram 24, ElevenLabs 9; Fal son tam testte 493. Cloudflare tam birleşimde mevcut Groq önceliği nedeniyle 35 oldu. Deepgram API bir canonical kimliği farklı dil/sürüm kayıtlarıyla tekrar gönderebildiği için sayım benzersiz katalog kimlikleri üzerinden yapılır.

## Davranış

- Eşleşme modelin ana kimliği ve gerçek sağlayıcı namespace’i üzerinden yapılır; açıklamadaki veya URL’nin ilerleyen kısımlarındaki marka isimleri izin sağlamaz.
- `perceptron/.../openai/...` gibi bir adapter yolu OpenAI modeli sayılmaz. Fal’ın mevcut eğitim/LoRA/utility filtreleri korunur.
- `Deepgram → Nova` ve Whisper eşleşir; Aura ve genel STT modelleri ekte olmadığı için çıkarılır.
- Aynı görünen ada sahip farklı API kimlikleri ayrı varyant olarak korunur.
- Merge sonrası filtre yeniden uygulanır; eski KV verisi izin dışı bir modeli geri getiremez.
- Kaynakların yeni standard/fallback tier bilgisi eski KV premium etiketine üstün gelir; eski online alias’larda kalan premium etiketi de ilgili standard/fallback değerine geçirilir.

## Doğrulama

- 25/25 otomatik test geçti: aile/üretici eşleşmesi, namespace taklidi, sayfalama, çakışan adlar, merge sonrası filtre, premium geçişi ve önceki offline keşif kontrolleri.
- Gerçek sağlayıcı API’leriyle dört kaynağın tamamından pozitif sonuç alındı.
- Tam deneme sonuçları: OpenRouter 263, Fal 493, Cloudflare 35, Groq 14, HuggingFace 222, manual 42, ElevenLabs 9, Deepgram 24. Sayılar API kataloğuna göre zaman içinde değişebilir.

## Deploy

- Syncer canlı sürüm: `76a221aa-9c58-4b4a-a358-c7b8197f66b8`.
- Curator canlı sürüm: `858cb82c-e677-4baa-ac9a-03dcc596ce59`.
- Her iki deploy başarılı. Syncer worker endpointi ve `cortexishere.com/models` HTTP 200 döndürüyor.
- Saatlik cron `5 * * * *` korundu. Deploy sonrası kontrol anında servis edilen liste son eski cron'a (`2026-09-08T20:05:38.501Z`) aitti; yeni katalog bir sonraki saatlik çalışmada yazılacak. Yukarıdaki 561 sayısı gerçek API'lerle yapılan tam senkronizasyon testinin sonucudur, henüz yayımlanmış yeni KV sayımı değildir.

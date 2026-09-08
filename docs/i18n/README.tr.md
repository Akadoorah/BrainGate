# BrainGate

**Zaten kullandığınız yapay zekâ kodlama aboneliklerini yöneten tek yerel kontrol düzlemi.**

BrainGate, resmî yapay zekâ kodlama CLI'larını birden çok yazılım projesi arasında
koordine eden, alfa öncesi bir projedir: her projenin bağlamını yalıtır, kota kullanımını
denetler ve her ajanın ne yaptığını kaydeder.

> Kaynak metin İngilizcedir: [`README.md`](../../README.md). Bu çeviri yalnızca kurulum ve
> ilk kullanımı kapsar; `docs/` altındaki geri kalan belgeler İngilizcedir.

**Diğer diller:**
[English](../../README.md) ·
[العربية](README.ar.md) ·
[Español](README.es.md) ·
[Français](README.fr.md) ·
[Deutsch](README.de.md) ·
[Português (BR)](README.pt-BR.md) ·
[Русский](README.ru.md) ·
[简体中文](README.zh-CN.md) ·
[日本語](README.ja.md) ·
[한국어](README.ko.md) ·
[हिन्दी](README.hi.md)

---

## Gereksinimler

| | |
|---|---|
| Node.js | 22 veya üzeri |
| Git | güncel herhangi bir sürüm |
| pnpm | Corepack ile (`corepack enable`) |
| Sağlayıcı CLI'ı | kontrolünüzdeki bir aboneliğe giriş yapılmış en az bir resmî CLI |

**BrainGate hiçbir zaman API anahtarı istemez.** Zaten giriş yaptığınız sağlayıcı CLI'larını
çalıştırır ve başlattığı alt süreçlerden bilinen API anahtarı ile temel URL değişkenlerini
temizler; böylece unutulmuş bir `ANTHROPIC_API_KEY` veya `OPENAI_API_KEY` sizi sessizce
belirteç başına faturalandırmaya geçiremez.

| Sağlayıcı | CLI | Durum |
|---|---|---|
| Anthropic Claude Code | `claude` | okuma ve yazma |
| OpenAI Codex | `codex` | yalnızca bağımsız denetçi, yalıtım öz testinden sonra |
| GitHub Copilot | `copilot` | yalnızca okuma, aboneliği siz beyan edersiniz |
| Google Antigravity | `agy` | yalnızca keşif; çalıştırma kapalı |
| xAI Grok Build | `grok` | yalnızca keşif; çalıştırma kapalı |

## Kurulum

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck && pnpm test
```

Ardından `braingate`'i PATH'e ekleyin. Başlatıcı kendi konumunu çözdüğü için tek bir sembolik
bağlantı yeterlidir — hiçbir şey kopyalanmaz, global kurulum yapılmaz:

```bash
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
braingate
```

Bağlantı bu kopyayı işaret eder; depo taşınır, adı değişir veya bağlı olmayan bir birimde
bulunursa komut çalışmayı bırakır.

## Hızlı başlangıç

**1. BrainGate'in ne gördüğünü öğrenin.** Önce her sağlayıcının kendi CLI'ıyla giriş yapın
(`claude`, `codex login`, …), sonra:

```bash
braingate discover
```

Kanıtlanamayan kimlik doğrulama varsayılmaz, `unknown` olarak bildirilir.

**2. Model kataloğunu yapılandırın.** BrainGate model kimlikleri, bağlam kapasiteleri veya
yetenek puanları uydurmaz; yönlendirilecek modelleri siz bildirirsiniz. Katalog **geneldir**:
bir kez yapılandırın, tüm projeler kullanır.

```bash
cat > claude-model.json <<'JSON'
{
  "providerId": "anthropic",
  "modelId": "<DOĞRULADIĞINIZ_MODEL_KIMLIĞI>",
  "quotaPool": "claude-subscription",
  "capabilities": { "coder": 88, "reviewer": 84, "judge": 82 },
  "speed": "balanced",
  "contextCapacity": 200000,
  "writeCapable": true,
  "reasoning": 85,
  "underlyingFamily": null
}
JSON

braingate models add --definition claude-model.json
braingate models profile
```

Kullanılmasını istediğiniz her model için bir girdi ekleyin. `speed` değeri `fast`, `balanced`
veya `deep` olur ve "önce ucuz" kaldıracıdır: basit görevlerde `fast`, zor görevlerde `deep`
tercih edilir. Puanlar sizin yönlendirme politikanızdır —
[`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) belgesine bakın.

**3. Bir depo kaydedin.**

```bash
cd /path/to/your/project
braingate init
```

Dizin adından bir proje kimliği önerir ve onayınızı ister. **Kimlik, yalıtım sınırıdır** —
bellek, worktree'ler ve telemetri ona göre kapsanır — bu yüzden BrainGate sessizce seçim
yapmaz. Betiklerde soruyu atlamak için `--project-id <id> --name <ad>` kullanın.

**4. Hazırlığı denetleyin. Bu hiçbir maliyet getirmez.**

```bash
braingate dogfood preflight
```

**5. Bir soru sorun.** Her zaman önce planlayın: plan hiçbir sağlayıcı çağrısı yapmaz;
sınıflandırmayı, hangi modelin çalışacağını ve denetçi gerekip gerekmediğini gösterir.

```bash
braingate dogfood ask plan --task "Tema yapılandırması nerede tanımlı?"
braingate dogfood ask run  --task "Tema yapılandırması nerede tanımlı?" --execute
```

**Bir modele ulaşan tek kapı `--execute`'tür.** Ondan öncesi kota harcamaz.

**6. Görevin gerçekte ne çıktığını kaydedin.** Yönlendirme böyle iyileşir.

```bash
braingate dogfood feedback --task-id <TASK_UUID> --actual-complexity T1 --outcome success
```

**7. Küçük bir değişiklik yapın.** Yazma işlemleri temiz bir çalışma kopyası gerektirir ve
göreve özel bir worktree içinde gerçekleşir — asla sizin çalışma ağacınızda değil.

```bash
braingate dogfood write plan --task "Boş durum etiketini X'ten Y'ye değiştir"
braingate dogfood write run  --task "Boş durum etiketini X'ten Y'ye değiştir" --execute
```

Bildirdiği dalı inceleyin ve isterseniz kendiniz birleştirin. **BrainGate birleştirme, push
veya dağıtım yapmaz.**

## Ne yapar, ne yapmaz

| Yapar | Asla yapmaz |
|---|---|
| Her görevi en ucuz yeterli modele yönlendirir | Sağlayıcı kimlik belirteci dosyalarını okumaz veya kopyalamaz |
| Riskli işlere bağımsız denetçi ekler | Çalışma kopyanıza yazmaz — değişiklikler worktree'ye gider |
| Sonradan çalışma kopyanızın değişmediğini doğrular | Hiçbir şeyi birleştirmez, push etmez, dağıtmaz |
| Kullanımı `native` / `measured` / `estimated` / `unknown` olarak etiketler | Tahmini ölçüm gibi sunmaz |
| Bellek, worktree ve telemetriyi proje başına ayırır | Varsayılan olarak bağlamı projeler arasında taşımaz |
| Yüksek riskli ve T3/T4 yazmalarını tümüyle engeller | Kimlik bilgilerini, `.env` içeriğini veya sırları bellekte saklamaz |

## Gerçekten çalıştığını doğrulama

`pnpm test` tüm paketi sağlayıcı çağrısı olmadan çalıştırır; bu BrainGate'in kendi mantığını
kanıtlar ama kurulu bir CLI'ın gerçek bir sonuç ürettiğini kanıtlamaz. İki isteğe bağlı
entegrasyon testi, tek kullanımlık bir depoya karşı gerçek sağlayıcıları çalıştırarak bu boşluğu
kapatır:

```bash
pnpm test:integration
```

Gerçek abonelik kotası harcarlar ve CI'da asla çalışmazlar. Bir sağlayıcı CLI'ını
yükselttikten veya bir sağlayıcı profiline dokunduktan sonra çalıştırın.
[`docs/DOGFOOD.md`](../DOGFOOD.md) belgesine bakın.

## Belgeler

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | parçaların nasıl birleştiği |
| [`docs/SECURITY.md`](../SECURITY.md) | güvenlik sınırları ve neden tuttukları |
| [`docs/SAFE_EXECUTION.md`](../SAFE_EXECUTION.md) | worktree'ler, komut izin listeleri, kapalı-başarısızlık kuralları |
| [`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) | bir görevin nasıl sınıflandırılıp yönlendirildiği |
| [`docs/DOGFOOD.md`](../DOGFOOD.md) | BrainGate'i gerçek bir depoda denemek |
| [`docs/adr/`](../adr) | kabul edilmiş mimari kararlar |

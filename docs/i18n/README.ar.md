# BrainGate

**لوحة تحكّم محلية واحدة لاشتراكات البرمجة بالذكاء الاصطناعي اللي عندك أصلاً.**

BrainGate مشروع بمرحلة ما قبل الألفا، بينسّق بين أدوات CLI الرسمية لمزوّدي الذكاء الاصطناعي عبر
عدّة مشاريع برمجية، مع عزل سياق كل مشروع، والتحكّم باستهلاك الحصة، وتسجيل ما فعله كل وكيل.

> النسخة الإنجليزية هي المرجع: [`README.md`](../../README.md). هذه الترجمة تغطّي التثبيت
> والاستخدام الأول فقط؛ بقية التوثيق تحت `docs/` بالإنجليزية.

**لغات أخرى:**
[English](../../README.md) ·
[Türkçe](README.tr.md) ·
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

## المتطلبات

| | |
|---|---|
| Node.js | 22 أو أحدث |
| Git | أي إصدار حديث |
| pnpm | عبر Corepack (`corepack enable`) |
| أداة مزوّد | أداة CLI رسمية واحدة على الأقل، مسجّل دخولها باشتراك تملكه |

**BrainGate لا يطلب مفتاح API أبداً.** يشغّل أدوات المزوّدين اللي سجّلت دخولها أصلاً، ويزيل
متغيّرات مفاتيح API وعناوين الـ base URL المعروفة من العمليات اللي يبدأها — حتى لا ينقلك
`ANTHROPIC_API_KEY` أو `OPENAI_API_KEY` منسي إلى الفوترة بالرمز دون أن تدري.

| المزوّد | الأداة | الحالة |
|---|---|---|
| Anthropic Claude Code | `claude` | قراءة وكتابة |
| OpenAI Codex | `codex` | مراجِع مستقل فقط، بعد اجتياز فحص عزل ذاتي |
| GitHub Copilot | `copilot` | قراءة فقط، بإقرار منك على الاشتراك |
| Google Antigravity | `agy` | اكتشاف فقط؛ التنفيذ مقفل |
| xAI Grok Build | `grok` | اكتشاف فقط؛ التنفيذ مقفل |

## التثبيت

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck && pnpm test
```

ثم ضع `braingate` في الـ PATH. المشغّل يحدّد موقعه بنفسه، فرابط رمزي واحد يكفي — لا نسخ ولا
تثبيت عام:

```bash
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
braingate
```

الرابط يشير إلى هذه النسخة من المستودع، فيتوقّف الأمر عن العمل إذا نقلته أو أعدت تسميته أو كان
على قرص غير موصول.

## البداية السريعة

**١. اعرف ماذا يرى BrainGate.** سجّل دخولك أولاً من أداة كل مزوّد (`claude`، `codex login`، …):

```bash
braingate discover
```

المصادقة التي لا يمكن إثباتها تُعرض كـ `unknown` بدل افتراضها.

**٢. اضبط كتالوج النماذج.** BrainGate لا يخترع معرّفات نماذج ولا سعات سياق ولا درجات قدرة، فأنت
تُعلن النماذج التي يوجّه إليها. الكتالوج **عام**: تضبطه مرة واحدة وتستخدمه كل المشاريع.

```bash
cat > claude-model.json <<'JSON'
{
  "providerId": "anthropic",
  "modelId": "<معرّف_النموذج_الذي_تحقّقت_منه>",
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

أضف مدخلاً لكل نموذج تريده متاحاً. القيمة `speed` تكون `fast` أو `balanced` أو `deep`، وهي
رافعة «الأرخص أولاً»: `fast` مفضّل في المهام البسيطة، و`deep` في الصعبة. الدرجات هي سياسة
التوجيه التي تكتبها أنت — راجع [`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md).

**٣. سجّل مستودعاً.**

```bash
cd /path/to/your/project
braingate init
```

يقترح معرّف مشروع من اسم المجلد ويطلب تأكيدك. **المعرّف هو حدود العزل** — الذاكرة و worktrees
والقياسات كلها مربوطة به — لذلك لا يختاره BrainGate بصمت. استخدم
`--project-id <id> --name <name>` لتخطّي السؤال في السكربتات.

**٤. تحقّق من الجاهزية. هذا لا يكلّف شيئاً.**

```bash
braingate dogfood preflight
```

**٥. اسأل سؤالاً.** خطّط أولاً دائماً: الخطة لا تستدعي أي مزوّد، وتُظهر لك التصنيف وأي نموذج
سيعمل وهل المراجعة مطلوبة.

```bash
braingate dogfood ask plan --task "أين تُعرَّف إعدادات الثيم؟"
braingate dogfood ask run  --task "أين تُعرَّف إعدادات الثيم؟" --execute
```

**`--execute` هي البوابة الوحيدة التي تصل إلى نموذج.** لا شيء قبلها يستهلك حصة.

**٦. سجّل ما تبيّن أن المهمة كانته فعلاً.** هكذا يتحسّن التوجيه.

```bash
braingate dogfood feedback --task-id <TASK_UUID> --actual-complexity T1 --outcome success
```

**٧. نفّذ تعديلاً صغيراً.** الكتابة تتطلّب نسخة عمل نظيفة، وتحدث في worktree خاص بالمهمة — لا
في مجلد عملك أبداً.

```bash
braingate dogfood write plan --task "غيّر نص الحالة الفارغة من X إلى Y"
braingate dogfood write run  --task "غيّر نص الحالة الفارغة من X إلى Y" --execute
```

راجع الفرع الذي يبلّغ عنه وادمجه بنفسك إن أردت. **BrainGate لا يدمج ولا يدفع ولا ينشر.**

## ما يفعله وما لا يفعله

| يفعل | لا يفعل أبداً |
|---|---|
| يوجّه كل مهمة إلى أرخص نموذج قادر | يقرأ أو ينسخ ملفات رموز المصادقة |
| يضيف مراجِعاً مستقلاً للعمل الخطر | يكتب في نسخة عملك — التعديلات في worktree منفصل |
| يتحقّق بعد التنفيذ أن نسختك لم تتغيّر | يدمج أو يدفع أو ينشر شيئاً |
| يصنّف الاستهلاك `native` / `measured` / `estimated` / `unknown` | يقدّم تقديراً على أنه قياس |
| يفصل الذاكرة و worktrees والقياسات لكل مشروع | ينقل السياق بين المشاريع افتراضياً |
| يمنع الكتابات عالية الخطورة و T3/T4 | يخزّن اعتمادات أو محتوى `.env` أو أسراراً في الذاكرة |

## التحقّق من أنه يعمل فعلاً

`pnpm test` يشغّل السويت كاملة بلا أي استدعاء مزوّد، وهذا يثبت منطق BrainGate نفسه لكنه لا يثبت
أن أداة مثبّتة أنتجت نتيجة حقيقية. اختباران تكامليان اختياريان يسدّان هذه الفجوة بتشغيل مزوّدين
حقيقيين على مستودع مؤقّت:

```bash
pnpm test:integration
```

يستهلكان حصة اشتراك حقيقية ولا يعملان في الـ CI أبداً. شغّلهما بعد ترقية أداة مزوّد أو بعد لمس
ملف تعريف مزوّد. راجع [`docs/DOGFOOD.md`](../DOGFOOD.md).

## التوثيق

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | كيف تتركّب الأجزاء |
| [`docs/SECURITY.md`](../SECURITY.md) | الحدود الأمنية ولماذا تصمد |
| [`docs/SAFE_EXECUTION.md`](../SAFE_EXECUTION.md) | worktrees وقوائم الأوامر المسموحة وقواعد الإقفال الآمن |
| [`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) | كيف تُصنَّف المهمة وتُوجَّه |
| [`docs/DOGFOOD.md`](../DOGFOOD.md) | تجربة BrainGate على مستودع حقيقي |
| [`docs/adr/`](../adr) | قرارات المعمارية المعتمدة |

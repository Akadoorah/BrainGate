# BrainGate

**이미 쓰고 있는 AI 코딩 구독을 위한 단일 로컬 제어 평면.**

BrainGate는 pre-alpha 단계의 프로젝트로, 각 사의 공식 AI 코딩 CLI를 여러 소프트웨어 프로젝트에
걸쳐 조율합니다. 프로젝트별로 컨텍스트를 격리하고, 할당량 사용을 통제하며, 각 에이전트가 무엇을
했는지 기록합니다.

> 기준은 영어판입니다: [`README.md`](../../README.md) · [`docs/GUIDE.md`](../GUIDE.md). 이 번역은 설치와 첫 사용만 다루며,
> `docs/` 아래의 나머지 문서는 영어입니다.

**다른 언어:**
[English](../../README.md) ·
[العربية](README.ar.md) ·
[Türkçe](README.tr.md) ·
[Español](README.es.md) ·
[Français](README.fr.md) ·
[Deutsch](README.de.md) ·
[Português (BR)](README.pt-BR.md) ·
[Русский](README.ru.md) ·
[简体中文](README.zh-CN.md) ·
[日本語](README.ja.md) ·
[हिन्दी](README.hi.md)

---

## 요구 사항

| | |
|---|---|
| Node.js | 22 이상 |
| Git | 최근 버전 아무거나 |
| pnpm | Corepack 경유 (`corepack enable`) |
| 공급자 CLI | 본인 구독으로 로그인된 공식 CLI 최소 1개 |

**BrainGate는 API 키를 절대 요구하지 않습니다.** 이미 로그인해 둔 공급자 CLI를 구동하며, 실행하는
하위 프로세스에서 알려진 API 키 및 base URL 변수를 제거합니다. 남아 있던 `ANTHROPIC_API_KEY`나
`OPENAI_API_KEY` 때문에 모르는 사이 토큰 과금으로 넘어가는 일을 막기 위해서입니다.

| 공급자 | CLI | 상태 |
|---|---|---|
| Anthropic Claude Code | `claude` | 읽기 및 쓰기 |
| OpenAI Codex | `codex` | 격리 자체 검사 통과 후 독립 검토자로만 |
| GitHub Copilot | `copilot` | 읽기 전용, 구독은 사용자가 확인 |
| Google Antigravity | `agy` | 계획·검토·판정 — 아래 위험을 수락한 뒤 |
| xAI Grok Build | `grok` | 계획·검토·판정, 샌드박스 자체 검사를 통과한 뒤 |

`braingate providers list` 를 실행하면 각 제공자가 이 머신에서 어떤 역할을 맡을 수 있는지, 닫힌 역할은 왜 닫혔는지 알 수 있습니다. 제공자가 역할을 얻는 방식과 `braingate providers accept` 로 무엇을 수락하게 되는지는 영어 README 의 **How a provider earns a role** 를 보세요.

## 설치

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck && pnpm test
```

그다음 `braingate`를 PATH에 둡니다. 런처가 자신의 위치를 스스로 확인하므로 심볼릭 링크 하나면
충분합니다. 아무것도 복사하지 않고, 전역 설치도 하지 않습니다.

```bash
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
braingate
```

링크는 이 체크아웃을 가리키므로, 저장소를 옮기거나 이름을 바꾸거나 마운트되지 않은 볼륨에 두면
명령이 동작하지 않습니다.

## 빠른 시작

**1. BrainGate가 무엇을 인식하는지 확인합니다.** 먼저 각 공급자의 CLI로 로그인한 뒤
(`claude`, `codex login` 등):

```bash
braingate discover
```

증명할 수 없는 인증 상태는 추정하지 않고 `unknown`으로 보고됩니다.

**2. 모델 카탈로그를 설정합니다.** BrainGate는 모델 ID, 컨텍스트 용량, 능력 점수를 임의로 만들지
않습니다. 라우팅 대상 모델은 사용자가 선언합니다. 카탈로그는 **전역**이라 한 번만 설정하면 모든
프로젝트가 사용합니다.

```bash
cat > claude-model.json <<'JSON'
{
  "providerId": "anthropic",
  "modelId": "<직접_확인한_모델ID>",
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

사용할 모델마다 항목을 하나씩 추가합니다. `speed`는 `fast`, `balanced`, `deep` 중 하나이며
"저렴한 것 우선" 레버입니다. 단순한 작업에는 `fast`가, 어려운 작업에는 `deep`이 유리합니다. 이
점수들이 곧 라우팅 정책입니다 —
[`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) 참고.

**3. 저장소를 등록합니다.**

```bash
cd /경로/프로젝트
braingate init
```

디렉터리 이름을 바탕으로 프로젝트 ID를 제안하고 확인을 요청합니다. **이 ID가 격리 경계**이며
메모리, worktree, 텔레메트리가 모두 여기에 묶이므로 BrainGate가 조용히 정하는 일은 없습니다.
스크립트에서는 `--project-id <id> --name <이름>`으로 질문을 건너뛸 수 있습니다.

**4. 준비 상태를 확인합니다. 여기까지는 소모가 없습니다.**

```bash
braingate dogfood preflight
```

**5. 질문합니다.** 항상 plan을 먼저 실행하세요. plan은 공급자를 전혀 호출하지 않으며 분류, 실행될
모델, 검토자 필요 여부를 보여 줍니다.

```bash
braingate dogfood ask plan --task "테마 설정은 어디에 정의돼 있나요?"
braingate dogfood ask run  --task "테마 설정은 어디에 정의돼 있나요?" --execute
```

**모델에 도달하는 유일한 관문은 `--execute`입니다.** 그 이전에는 할당량이 소모되지 않습니다.

**6. 그 작업이 실제로 무엇이었는지 기록합니다.** 라우팅은 이렇게 개선됩니다.

```bash
braingate dogfood feedback --task-id <TASK_UUID> --actual-complexity T1 --outcome success
```

**7. 작은 변경을 시도합니다.** 쓰기는 깨끗한 작업 사본을 요구하며, 작업 전용 worktree 안에서만
이뤄집니다. 사용자의 작업 트리는 건드리지 않습니다.

```bash
braingate dogfood write plan --task "빈 상태 라벨을 X에서 Y로 변경"
braingate dogfood write run  --task "빈 상태 라벨을 X에서 Y로 변경" --execute
```

알려 주는 브랜치를 검토하고, 마음에 들면 직접 머지하세요. **BrainGate는 머지, push, 배포를 하지
않습니다.**

## 하는 일과 하지 않는 일

| 합니다 | 절대 하지 않습니다 |
|---|---|
| 각 작업을 감당 가능한 가장 저렴한 모델로 라우팅 | 공급자 인증 토큰 파일을 읽거나 복사 |
| 위험한 작업에 독립 검토자를 추가 | 작업 사본에 쓰기 — 변경은 worktree로 |
| 사후에 작업 사본이 그대로인지 검증 | 머지, push, 배포 |
| 사용량을 `native` / `measured` / `estimated` / `unknown`으로 표기 | 추정치를 측정값처럼 제시 |
| 메모리, worktree, 텔레메트리를 프로젝트별로 분리 | 기본적으로 프로젝트 경계를 넘어 컨텍스트 이동 |
| 고위험 및 T3/T4 쓰기를 차단 | 자격 증명, `.env` 내용, 비밀 값을 메모리에 저장 |

## 실제로 동작하는지 검증하기

`pnpm test`는 공급자 호출 없이 전체 스위트를 실행합니다. 이는 BrainGate 자체 로직을 증명하지만,
설치된 CLI가 실제 결과를 냈다는 증명은 되지 않습니다. 두 개의 선택적 통합 테스트가 일회용 저장소를
대상으로 실제 공급자를 구동해 그 간극을 메웁니다.

```bash
pnpm test:integration
```

실제 구독 할당량을 소모하며 CI에서는 절대 실행되지 않습니다. 공급자 CLI를 업그레이드했거나 공급자
프로파일을 수정한 뒤 실행하세요. [`docs/DOGFOOD.md`](../DOGFOOD.md) 참고.

## 문서

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | 구성 요소가 어떻게 맞물리는지 |
| [`docs/SECURITY.md`](../SECURITY.md) | 보안 경계와 그것이 성립하는 이유 |
| [`docs/SAFE_EXECUTION.md`](../SAFE_EXECUTION.md) | worktree, 명령 허용 목록, fail-closed 규칙 |
| [`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) | 작업의 분류와 라우팅 방식 |
| [`docs/DOGFOOD.md`](../DOGFOOD.md) | 실제 저장소에서 시험 사용 |
| [`docs/adr/`](../adr) | 채택된 아키텍처 결정 |

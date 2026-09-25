# BrainGate

**为你已有的 AI 编程订阅提供的单一本地控制平面。**

BrainGate 是一个 pre-alpha 阶段的项目，用于在多个软件项目之间协调各家官方 AI 编程 CLI：隔离每个
项目的上下文、控制配额消耗，并记录每个智能体做过什么。

> 以英文版为准：[`README.md`](../../README.md) · [`docs/GUIDE.md`](../GUIDE.md)。本译文仅涵盖安装与首次使用；`docs/` 下的其余
> 文档为英文。

**其他语言：**
[English](../../README.md) ·
[العربية](README.ar.md) ·
[Türkçe](README.tr.md) ·
[Español](README.es.md) ·
[Français](README.fr.md) ·
[Deutsch](README.de.md) ·
[Português (BR)](README.pt-BR.md) ·
[Русский](README.ru.md) ·
[日本語](README.ja.md) ·
[한국어](README.ko.md) ·
[हिन्दी](README.hi.md)

---

## 环境要求

| | |
|---|---|
| Node.js | 22 或更高 |
| Git | 任意较新版本 |
| pnpm | 通过 Corepack（`corepack enable`） |
| 供应商 CLI | 至少一个官方 CLI，且已登录你自己的订阅 |

**BrainGate 从不索取 API 密钥。** 它驱动你已经登录的供应商 CLI，并从其启动的子进程中剔除已知的
API 密钥与 base URL 变量，避免遗留的 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY` 悄悄把你切换到
按 token 计费。

| 供应商 | CLI | 状态 |
|---|---|---|
| Anthropic Claude Code | `claude` | 读与写 |
| OpenAI Codex | `codex` | 仅作独立评审，需先通过隔离自检 |
| GitHub Copilot | `copilot` | 只读，订阅由你声明 |
| Google Antigravity | `agy` | 规划、评审与裁决 —— 在你接受下方风险之后 |
| xAI Grok Build | `grok` | 规划、评审与裁决，需先通过一次沙箱自检 |

运行 `braingate providers list` 查看每个提供方在你机器上可以承担哪些角色，以及被关闭的角色为何关闭。提供方如何取得角色、以及 `braingate providers accept` 到底让你接受了什么，见英文 README 的 **How a provider earns a role** 一节。

## 安装

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck && pnpm test
```

然后把 `braingate` 放进 PATH。启动器会自行解析所在位置，因此一个符号链接就够了——不复制任何文件，
也不做全局安装：

```bash
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
braingate
```

该链接指向当前这份仓库副本；一旦仓库被移动、改名，或所在卷未挂载，命令即失效。

## 快速开始

**1. 看看 BrainGate 能识别到什么。** 先用各供应商自己的 CLI 登录（`claude`、`codex login` 等），
然后：

```bash
braingate discover
```

无法证明的认证状态会如实报告为 `unknown`，而不是想当然地假定。

**2. 配置模型目录。** BrainGate 不会凭空编造模型 ID、上下文容量或能力评分，需要由你声明要路由到
哪些模型。该目录是**全局的**：配置一次，所有项目共用。

```bash
cat > claude-model.json <<'JSON'
{
  "providerId": "anthropic",
  "modelId": "<你已核实的模型ID>",
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

每个要启用的模型添加一条。`speed` 取 `fast`、`balanced` 或 `deep`，这是「先用便宜的」这一杠杆：
简单任务偏向 `fast`，困难任务偏向 `deep`。这些评分就是你的路由策略，参见
[`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md)。

**3. 注册一个仓库。**

```bash
cd /你的/项目/路径
braingate init
```

它会根据目录名给出项目 ID 建议并请你确认。**该 ID 就是隔离边界**——记忆、worktree 与遥测都以它
为范围——所以 BrainGate 绝不会静默选定。脚本中可用 `--project-id <id> --name <名称>` 跳过询问。

**4. 检查就绪状态。这一步不消耗任何配额。**

```bash
braingate dogfood preflight
```

**5. 提出一个问题。** 请务必先 plan：plan 不会发起任何供应商调用，只展示任务分级、将要运行的模型，
以及是否需要评审。

```bash
braingate dogfood ask plan --task "主题配置在哪里定义？"
braingate dogfood ask run  --task "主题配置在哪里定义？" --execute
```

**`--execute` 是唯一能触达模型的闸门。** 在它之前的一切都不消耗配额。

**6. 记录这个任务实际是什么。** 路由正是靠这个变准。

```bash
braingate dogfood feedback --task-id <TASK_UUID> --actual-complexity T1 --outcome success
```

**7. 做一次小改动。** 写入要求工作副本干净，并且只发生在该任务专属的 worktree 中——绝不会动你的
工作树。

```bash
braingate dogfood write plan --task "把空状态文案从 X 改为 Y"
braingate dogfood write run  --task "把空状态文案从 X 改为 Y" --execute
```

审阅它给出的分支，满意再由你自己合并。**BrainGate 不会执行 merge、push 或部署。**

## 它做什么，不做什么

| 它会 | 它绝不会 |
|---|---|
| 把每个任务路由到最便宜的可胜任模型 | 读取或复制供应商的认证令牌文件 |
| 为高风险工作加入独立评审 | 写入你的工作副本——改动一律进入 worktree |
| 事后核验你的工作副本未被改动 | 执行任何 merge、push 或部署 |
| 将用量标注为 `native` / `measured` / `estimated` / `unknown` | 把估算当作实测呈现 |
| 按项目隔离记忆、worktree 与遥测 | 默认跨项目携带上下文 |
| 直接阻断高风险以及 T3/T4 级别的写入 | 在记忆中保存凭据、`.env` 内容或密钥 |

## 验证它确实可用

`pnpm test` 会在完全不调用供应商的情况下跑完整套测试，这能证明 BrainGate 自身的逻辑，却证明不了
已安装的 CLI 真的产出过结果。两个可选的集成测试通过在一次性仓库上驱动真实供应商来补上这个缺口：

```bash
pnpm test:integration
```

它们会消耗真实的订阅配额，且永远不在 CI 中运行。请在升级供应商 CLI 或改动供应商 profile 之后运行。
参见 [`docs/DOGFOOD.md`](../DOGFOOD.md)。

## 文档

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | 各部分如何组合 |
| [`docs/SECURITY.md`](../SECURITY.md) | 安全边界及其成立的理由 |
| [`docs/SAFE_EXECUTION.md`](../SAFE_EXECUTION.md) | worktree、命令白名单、fail-closed 规则 |
| [`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) | 任务如何被分级与路由 |
| [`docs/DOGFOOD.md`](../DOGFOOD.md) | 在真实仓库上试用 BrainGate |
| [`docs/adr/`](../adr) | 已采纳的架构决策 |

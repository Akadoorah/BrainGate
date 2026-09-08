# BrainGate

**すでに使っている AI コーディング用サブスクリプションのための、単一のローカル制御プレーン。**

BrainGate は pre-alpha 段階のプロジェクトで、各社公式の AI コーディング CLI を複数の
ソフトウェアプロジェクトにまたがって調停します。プロジェクトごとにコンテキストを隔離し、
クォータ消費を制御し、どのエージェントが何をしたかを記録します。

> 正典は英語版です: [`README.md`](../../README.md)。この翻訳はインストールと初回利用のみを
> 対象とし、`docs/` 以下のその他のドキュメントは英語です。

**他の言語:**
[English](../../README.md) ·
[العربية](README.ar.md) ·
[Türkçe](README.tr.md) ·
[Español](README.es.md) ·
[Français](README.fr.md) ·
[Deutsch](README.de.md) ·
[Português (BR)](README.pt-BR.md) ·
[Русский](README.ru.md) ·
[简体中文](README.zh-CN.md) ·
[한국어](README.ko.md) ·
[हिन्दी](README.hi.md)

---

## 必要環境

| | |
|---|---|
| Node.js | 22 以上 |
| Git | 比較的新しい任意のバージョン |
| pnpm | Corepack 経由（`corepack enable`） |
| プロバイダ CLI | 自分が保有するサブスクリプションにサインイン済みの公式 CLI が最低 1 つ |

**BrainGate が API キーを要求することはありません。** すでにサインイン済みのプロバイダ CLI を
駆動し、起動する子プロセスから既知の API キー変数と base URL 変数を取り除きます。残っていた
`ANTHROPIC_API_KEY` や `OPENAI_API_KEY` によって、知らぬ間にトークン課金へ切り替わることを防ぎます。

| プロバイダ | CLI | 状態 |
|---|---|---|
| Anthropic Claude Code | `claude` | 読み取りと書き込み |
| OpenAI Codex | `codex` | 独立レビュアー専用（隔離セルフテスト通過後） |
| GitHub Copilot | `copilot` | 読み取り専用、サブスクリプションは利用者が申告 |
| Google Antigravity | `agy` | 計画・レビュー・裁定 — 下記のリスクを受け入れたうえで |
| xAI Grok Build | `grok` | 計画・レビュー・裁定。サンドボックス自己テストの通過後 |

`braingate providers list` を実行すると、各プロバイダがこのマシンでどの役割を担えるか、閉じている役割はなぜ閉じているかが分かります。プロバイダが役割を得る仕組みと、`braingate providers accept` で何を受け入れることになるのかは、英語 README の **How a provider earns a role** を参照してください。

## インストール

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck && pnpm test
```

続いて `braingate` を PATH に置きます。ランチャーは自身の位置を解決するため、シンボリックリンク
だけで十分です。コピーもグローバルインストールも行いません。

```bash
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
braingate
```

リンクはこのチェックアウトを指すため、リポジトリを移動・改名した場合や、マウントされていない
ボリューム上にある場合はコマンドが動かなくなります。

## クイックスタート

**1. BrainGate から何が見えるか確認する。** まず各プロバイダ自身の CLI でサインインし
（`claude`、`codex login` など）、その後:

```bash
braingate discover
```

証明できない認証状態は、推測せずに `unknown` として報告されます。

**2. モデルカタログを設定する。** BrainGate はモデル ID、コンテキスト容量、能力スコアを勝手に
作りません。ルーティング先のモデルは利用者が宣言します。カタログは**グローバル**で、一度設定
すればすべてのプロジェクトで使われます。

```bash
cat > claude-model.json <<'JSON'
{
  "providerId": "anthropic",
  "modelId": "<自分で確認したモデルID>",
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

使いたいモデルごとに 1 件ずつ追加します。`speed` は `fast`・`balanced`・`deep` のいずれかで、
「安いものから」のレバーです。単純なタスクでは `fast`、難しいタスクでは `deep` が優先されます。
スコアはそのままルーティングポリシーになります —
[`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) を参照。

**3. リポジトリを登録する。**

```bash
cd /path/to/your/project
braingate init
```

ディレクトリ名からプロジェクト ID を提案し、確認を求めます。**この ID が隔離境界**であり、
メモリ・worktree・テレメトリはすべてこれにひも付くため、BrainGate が黙って決めることはありません。
スクリプトでは `--project-id <id> --name <名前>` で質問を省略できます。

**4. 準備状況を確認する。ここまでで消費はゼロです。**

```bash
braingate dogfood preflight
```

**5. 質問する。** 必ず先に plan を実行してください。plan はプロバイダ呼び出しを一切行わず、
分類・実行されるモデル・レビュアーの要否を提示します。

```bash
braingate dogfood ask plan --task "テーマ設定はどこで定義されている？"
braingate dogfood ask run  --task "テーマ設定はどこで定義されている？" --execute
```

**モデルに到達する唯一のゲートが `--execute` です。** それ以前はクォータを消費しません。

**6. そのタスクが実際どうだったかを記録する。** ルーティングはこれで改善します。

```bash
braingate dogfood feedback --task-id <TASK_UUID> --actual-complexity T1 --outcome success
```

**7. 小さな変更を加える。** 書き込みはクリーンな作業コピーを必要とし、タスク専用の worktree
内で行われます。あなたの作業ツリーが書き換わることはありません。

```bash
braingate dogfood write plan --task "空状態のラベルを X から Y に変更"
braingate dogfood write run  --task "空状態のラベルを X から Y に変更" --execute
```

提示されたブランチを確認し、納得できれば自分でマージしてください。**BrainGate はマージ・push・
デプロイを一切行いません。**

## すること・しないこと

| すること | 決してしないこと |
|---|---|
| 各タスクを、能力の足りる最も安いモデルへ振り分ける | プロバイダの認証トークンファイルを読む・複製する |
| リスクの高い作業に独立レビュアーを付ける | 作業コピーへ書き込む（変更は worktree に入る） |
| 事後に作業コピーが無傷であることを検証する | マージ・push・デプロイを行う |
| 使用量を `native` / `measured` / `estimated` / `unknown` で明示する | 推定値を実測値として提示する |
| メモリ・worktree・テレメトリをプロジェクト単位で分離する | 既定でプロジェクト境界を越えてコンテキストを持ち出す |
| 高リスクおよび T3/T4 の書き込みを遮断する | 資格情報・`.env` の内容・秘密情報をメモリに保存する |

## 実際に動くことの確認

`pnpm test` はプロバイダ呼び出しなしで全スイートを実行します。これは BrainGate 自身のロジックを
証明しますが、インストール済みの CLI が実際に結果を返したことは証明しません。2 つのオプトイン
統合テストが、使い捨てリポジトリに対して実プロバイダを動かしてこのギャップを埋めます。

```bash
pnpm test:integration
```

実際のサブスクリプションのクォータを消費し、CI では決して実行されません。プロバイダ CLI の
アップグレード後や、プロバイダプロファイルの変更後に実行してください。
[`docs/DOGFOOD.md`](../DOGFOOD.md) を参照。

## ドキュメント

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | 各要素の組み合わせ方 |
| [`docs/SECURITY.md`](../SECURITY.md) | セキュリティ境界と、それが成り立つ理由 |
| [`docs/SAFE_EXECUTION.md`](../SAFE_EXECUTION.md) | worktree、コマンド許可リスト、フェイルクローズド規則 |
| [`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) | タスクの分類とルーティング |
| [`docs/DOGFOOD.md`](../DOGFOOD.md) | 実際のリポジトリでの試用 |
| [`docs/adr/`](../adr) | 承認済みのアーキテクチャ決定 |

# BrainGate

**Um único plano de controle local para as assinaturas de IA para programação que você já usa.**

O BrainGate é um projeto em fase pré-alfa que coordena as CLIs oficiais de IA para programação
entre vários projetos de software, mantendo isolado o contexto de cada projeto, controlando o
consumo de cota e registrando o que cada agente fez.

> O inglês é a fonte da verdade: [`README.md`](../../README.md). Esta tradução cobre instalação
> e primeiro uso; o restante da documentação em `docs/` está em inglês.

**Outros idiomas:**
[English](../../README.md) ·
[العربية](README.ar.md) ·
[Türkçe](README.tr.md) ·
[Español](README.es.md) ·
[Français](README.fr.md) ·
[Deutsch](README.de.md) ·
[Русский](README.ru.md) ·
[简体中文](README.zh-CN.md) ·
[日本語](README.ja.md) ·
[한국어](README.ko.md) ·
[हिन्दी](README.hi.md)

---

## Requisitos

| | |
|---|---|
| Node.js | 22 ou superior |
| Git | qualquer versão recente |
| pnpm | via Corepack (`corepack enable`) |
| Uma CLI de provedor | ao menos uma CLI oficial, com sessão iniciada em uma assinatura sua |

**O BrainGate nunca pede chave de API.** Ele executa as CLIs de provedor nas quais você já fez
login e remove dos subprocessos que inicia as variáveis conhecidas de chave de API e de URL
base, para que um `ANTHROPIC_API_KEY` ou `OPENAI_API_KEY` esquecido não o mova silenciosamente
para cobrança por token.

| Provedor | CLI | Situação |
|---|---|---|
| Anthropic Claude Code | `claude` | leitura e escrita |
| OpenAI Codex | `codex` | apenas revisor independente, após autoteste de isolamento |
| GitHub Copilot | `copilot` | somente leitura, com a assinatura atestada por você |
| Google Antigravity | `agy` | planejamento, revisão e arbitragem — depois de você aceitar o risco abaixo |
| xAI Grok Build | `grok` | planejamento, revisão e arbitragem, após um autoteste de isolamento |

Rode `braingate providers list` para ver qual papel cada provedor pode assumir na sua máquina e por que os fechados estão fechados. Veja **How a provider earns a role** no README em inglês para entender como um provedor conquista seu papel e o que você aceita com `braingate providers accept`.

## Instalação

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck && pnpm test
```

Depois coloque `braingate` no PATH. O lançador resolve a própria localização, então um link
simbólico basta — nada é copiado e nada é instalado globalmente:

```bash
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
braingate
```

O link aponta para esta cópia do repositório, então o comando para de funcionar se você movê-lo,
renomeá-lo, ou se ele estiver em um volume não montado.

## Início rápido

**1. Veja o que o BrainGate enxerga.** Faça login primeiro pela CLI de cada provedor (`claude`,
`codex login`, …) e então:

```bash
braingate discover
```

Autenticação que não pode ser comprovada é reportada como `unknown`, em vez de presumida.

**2. Configure o catálogo de modelos.** O BrainGate não inventa identificadores de modelo,
capacidades de contexto nem pontuações — você declara os modelos para os quais roteá-lo. O
catálogo é **global**: configure uma vez e todos os projetos usam.

```bash
cat > claude-model.json <<'JSON'
{
  "providerId": "anthropic",
  "modelId": "<ID_DE_MODELO_QUE_VOCE_VERIFICOU>",
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

Adicione uma entrada por modelo que quiser disponível. `speed` é `fast`, `balanced` ou `deep`, e
é a alavanca do "mais barato primeiro": `fast` é preferido em tarefas simples e `deep` nas
difíceis. As pontuações são a sua política de roteamento — veja
[`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md).

**3. Registre um repositório.**

```bash
cd /caminho/para/seu/projeto
braingate init
```

Ele propõe um identificador de projeto a partir do nome do diretório e pede confirmação. **O
identificador é a fronteira de isolamento** — memória, worktrees e telemetria são delimitados
por ele —, por isso o BrainGate nunca escolhe um em silêncio. Use
`--project-id <id> --name <nome>` para pular a pergunta em scripts.

**4. Verifique a prontidão. Isso não gasta nada.**

```bash
braingate dogfood preflight
```

**5. Faça uma pergunta.** Sempre planeje antes: um plano não faz nenhuma chamada ao provedor e
mostra a classificação, qual modelo rodaria e se um revisor é exigido.

```bash
braingate dogfood ask plan --task "Onde a configuração de tema é definida?"
braingate dogfood ask run  --task "Onde a configuração de tema é definida?" --execute
```

**`--execute` é o único portão que alcança um modelo.** Nada antes dele consome cota.

**6. Registre o que a tarefa se revelou ser.** É assim que o roteamento melhora.

```bash
braingate dogfood feedback --task-id <TASK_UUID> --actual-complexity T1 --outcome success
```

**7. Faça uma alteração pequena.** Escritas exigem uma cópia de trabalho limpa e acontecem em um
worktree próprio da tarefa — nunca na sua árvore de trabalho.

```bash
braingate dogfood write plan --task "Mude o rótulo de estado vazio de X para Y"
braingate dogfood write run  --task "Mude o rótulo de estado vazio de X para Y" --execute
```

Revise o branch informado e faça o merge você mesmo, se quiser. **O BrainGate não faz merge,
push nem deploy.**

## O que ele faz e o que não faz

| Faz | Nunca faz |
|---|---|
| Roteia cada tarefa para o modelo capaz mais barato | Ler ou copiar arquivos de token de autenticação |
| Adiciona um revisor independente em trabalho arriscado | Escrever na sua cópia de trabalho — as mudanças vão para um worktree |
| Verifica depois que sua cópia continua intacta | Fazer merge, push ou deploy de qualquer coisa |
| Rotula o uso como `native` / `measured` / `estimated` / `unknown` | Apresentar uma estimativa como medição |
| Separa memória, worktrees e telemetria por projeto | Levar contexto entre projetos por padrão |
| Bloqueia escritas de alto risco e de nível T3/T4 | Guardar credenciais, conteúdo de `.env` ou segredos em memória |

## Comprovar que realmente funciona

`pnpm test` roda a suíte inteira sem chamadas ao provedor, o que prova a lógica do próprio
BrainGate, mas não que uma CLI instalada produziu um resultado real. Dois testes de integração
opcionais fecham essa lacuna executando provedores reais contra um repositório descartável:

```bash
pnpm test:integration
```

Eles gastam cota real de assinatura e nunca rodam em CI. Execute-os após atualizar uma CLI de
provedor ou mexer em um perfil de provedor. Veja [`docs/DOGFOOD.md`](../DOGFOOD.md).

## Documentação

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | como as peças se encaixam |
| [`docs/SECURITY.md`](../SECURITY.md) | os limites de segurança e por que se sustentam |
| [`docs/SAFE_EXECUTION.md`](../SAFE_EXECUTION.md) | worktrees, listas de comandos permitidos, regras de falha segura |
| [`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) | como uma tarefa é classificada e roteada |
| [`docs/DOGFOOD.md`](../DOGFOOD.md) | testar o BrainGate em um repositório real |
| [`docs/adr/`](../adr) | decisões de arquitetura aceitas |

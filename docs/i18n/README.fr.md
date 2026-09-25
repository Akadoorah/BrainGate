# BrainGate

**Un seul plan de contrôle local pour les abonnements d'IA de développement que vous utilisez déjà.**

BrainGate est un projet en phase pré-alpha qui coordonne les CLI officielles d'IA pour le
développement sur plusieurs projets logiciels, en isolant le contexte de chaque projet, en
maîtrisant la consommation de quota et en consignant ce qu'a fait chaque agent.

> L'anglais fait foi : [`README.md`](../../README.md) · [`docs/GUIDE.md`](../GUIDE.md). Cette traduction couvre l'installation et
> la première utilisation ; le reste de la documentation dans `docs/` est en anglais.

**Autres langues :**
[English](../../README.md) ·
[العربية](README.ar.md) ·
[Türkçe](README.tr.md) ·
[Español](README.es.md) ·
[Deutsch](README.de.md) ·
[Português (BR)](README.pt-BR.md) ·
[Русский](README.ru.md) ·
[简体中文](README.zh-CN.md) ·
[日本語](README.ja.md) ·
[한국어](README.ko.md) ·
[हिन्दी](README.hi.md)

---

## Prérequis

| | |
|---|---|
| Node.js | 22 ou plus |
| Git | toute version récente |
| pnpm | via Corepack (`corepack enable`) |
| Une CLI de fournisseur | au moins une CLI officielle, connectée à un abonnement qui vous appartient |

**BrainGate ne demande jamais de clé d'API.** Il pilote les CLI de fournisseur auxquelles vous
êtes déjà connecté et retire des sous-processus qu'il lance les variables connues de clé d'API
et d'URL de base, afin qu'un `ANTHROPIC_API_KEY` ou `OPENAI_API_KEY` oublié ne vous bascule pas
silencieusement vers une facturation au jeton.

| Fournisseur | CLI | État |
|---|---|---|
| Anthropic Claude Code | `claude` | lecture et écriture |
| OpenAI Codex | `codex` | relecteur indépendant uniquement, après un auto-test d'isolation |
| GitHub Copilot | `copilot` | lecture seule, abonnement attesté par vous |
| Google Antigravity | `agy` | planification, revue et arbitrage — après avoir accepté le risque ci-dessous |
| xAI Grok Build | `grok` | planification, revue et arbitrage, après un auto-test d'isolement |

Lancez `braingate providers list` pour voir quel rôle chaque fournisseur peut prendre sur votre machine, et pourquoi les rôles fermés le sont. Voir **How a provider earns a role** dans le README anglais pour comprendre comment un fournisseur gagne son rôle et ce que vous acceptez avec `braingate providers accept`.

## Installation

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck && pnpm test
```

Placez ensuite `braingate` dans le PATH. Le lanceur résout son propre emplacement, un lien
symbolique suffit donc : rien n'est copié, rien n'est installé globalement.

```bash
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
braingate
```

Le lien pointe vers cette copie du dépôt : la commande cesse de fonctionner si vous le
déplacez, le renommez, ou s'il réside sur un volume non monté.

## Démarrage rapide

**1. Voyez ce que BrainGate détecte.** Connectez-vous d'abord avec la CLI de chaque fournisseur
(`claude`, `codex login`, …), puis :

```bash
braingate discover
```

Une authentification qui ne peut pas être prouvée est signalée `unknown` plutôt que supposée.

**2. Configurez le catalogue de modèles.** BrainGate n'invente ni identifiants de modèle, ni
capacités de contexte, ni scores : vous déclarez les modèles vers lesquels router. Le catalogue
est **global** : configurez-le une fois, tous les projets l'utilisent.

```bash
cat > claude-model.json <<'JSON'
{
  "providerId": "anthropic",
  "modelId": "<ID_DE_MODELE_QUE_VOUS_AVEZ_VERIFIE>",
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

Ajoutez une entrée par modèle souhaité. `speed` vaut `fast`, `balanced` ou `deep` : c'est le
levier « le moins cher d'abord », `fast` étant privilégié sur les tâches simples et `deep` sur
les difficiles. Les scores constituent votre politique de routage — voir
[`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md).

**3. Enregistrez un dépôt.**

```bash
cd /chemin/vers/votre/projet
braingate init
```

Il propose un identifiant de projet d'après le nom du répertoire et vous demande de confirmer.
**L'identifiant est la frontière d'isolation** — mémoire, worktrees et télémétrie y sont
rattachés — c'est pourquoi BrainGate n'en choisit jamais un en silence. Utilisez
`--project-id <id> --name <nom>` pour ignorer la question dans un script.

**4. Vérifiez que tout est prêt. Cela ne coûte rien.**

```bash
braingate dogfood preflight
```

**5. Posez une question.** Planifiez toujours d'abord : un plan n'effectue aucun appel au
fournisseur et vous montre la classification, le modèle qui serait utilisé et si un relecteur
est requis.

```bash
braingate dogfood ask plan --task "Où est définie la configuration du thème ?"
braingate dogfood ask run  --task "Où est définie la configuration du thème ?" --execute
```

**`--execute` est la seule porte qui atteint un modèle.** Rien avant elle ne consomme de quota.

**6. Consignez ce que la tâche s'est révélée être.** C'est ainsi que le routage s'améliore.

```bash
braingate dogfood feedback --task-id <TASK_UUID> --actual-complexity T1 --outcome success
```

**7. Faites une petite modification.** Les écritures exigent une copie de travail propre et ont
lieu dans un worktree dédié à la tâche, jamais dans votre arbre de travail.

```bash
braingate dogfood write plan --task "Change le libellé d'état vide de X en Y"
braingate dogfood write run  --task "Change le libellé d'état vide de X en Y" --execute
```

Relisez la branche indiquée et fusionnez-la vous-même si elle vous convient. **BrainGate ne
fusionne pas, ne pousse pas et ne déploie pas.**

## Ce qu'il fait et ne fait pas

| Il fait | Il ne fait jamais |
|---|---|
| Router chaque tâche vers le modèle capable le moins cher | Lire ou copier les fichiers de jetons d'authentification |
| Ajouter un relecteur indépendant sur les travaux risqués | Écrire dans votre copie de travail — les changements vont dans un worktree |
| Vérifier après coup que votre copie est intacte | Fusionner, pousser ou déployer quoi que ce soit |
| Étiqueter l'usage `native` / `measured` / `estimated` / `unknown` | Présenter une estimation comme une mesure |
| Cloisonner mémoire, worktrees et télémétrie par projet | Faire circuler le contexte entre projets par défaut |
| Bloquer les écritures à haut risque et de niveau T3/T4 | Stocker des identifiants, le contenu de `.env` ou des secrets en mémoire |

## Vérifier que cela fonctionne vraiment

`pnpm test` exécute toute la suite sans appel de fournisseur, ce qui prouve la logique propre de
BrainGate mais pas qu'une CLI installée ait produit un résultat réel. Deux tests d'intégration
optionnels comblent cet écart en faisant travailler de vrais fournisseurs sur un dépôt jetable :

```bash
pnpm test:integration
```

Ils consomment un quota d'abonnement réel et ne s'exécutent jamais en CI. Lancez-les après la
mise à jour d'une CLI de fournisseur ou la modification d'un profil de fournisseur. Voir
[`docs/DOGFOOD.md`](../DOGFOOD.md).

## Documentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | comment les pièces s'assemblent |
| [`docs/SECURITY.md`](../SECURITY.md) | les frontières de sécurité et pourquoi elles tiennent |
| [`docs/SAFE_EXECUTION.md`](../SAFE_EXECUTION.md) | worktrees, listes de commandes autorisées, règles de fermeture sûre |
| [`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) | comment une tâche est classée et routée |
| [`docs/DOGFOOD.md`](../DOGFOOD.md) | essayer BrainGate sur un dépôt réel |
| [`docs/adr/`](../adr) | décisions d'architecture acceptées |

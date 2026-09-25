# BrainGate

**Eine lokale Steuerungsebene für die KI-Coding-Abos, die Sie ohnehin nutzen.**

BrainGate ist ein Projekt im Pre-Alpha-Stadium, das die offiziellen KI-Coding-CLIs über mehrere
Softwareprojekte hinweg koordiniert: Es hält den Kontext jedes Projekts getrennt, kontrolliert
den Kontingentverbrauch und protokolliert, was jeder Agent getan hat.

> Maßgeblich ist die englische Fassung: [`README.md`](../../README.md) · [`docs/GUIDE.md`](../GUIDE.md). Diese Übersetzung deckt
> Installation und erste Nutzung ab; die übrige Dokumentation unter `docs/` ist englisch.

**Weitere Sprachen:**
[English](../../README.md) ·
[العربية](README.ar.md) ·
[Türkçe](README.tr.md) ·
[Español](README.es.md) ·
[Français](README.fr.md) ·
[Português (BR)](README.pt-BR.md) ·
[Русский](README.ru.md) ·
[简体中文](README.zh-CN.md) ·
[日本語](README.ja.md) ·
[한국어](README.ko.md) ·
[हिन्दी](README.hi.md)

---

## Voraussetzungen

| | |
|---|---|
| Node.js | 22 oder neuer |
| Git | eine aktuelle Version |
| pnpm | über Corepack (`corepack enable`) |
| Eine Anbieter-CLI | mindestens eine offizielle CLI, angemeldet an einem Abo, das Ihnen gehört |

**BrainGate verlangt niemals einen API-Schlüssel.** Es steuert die Anbieter-CLIs, bei denen Sie
bereits angemeldet sind, und entfernt aus den gestarteten Unterprozessen die bekannten
Variablen für API-Schlüssel und Basis-URLs. So kann ein vergessener `ANTHROPIC_API_KEY` oder
`OPENAI_API_KEY` Sie nicht unbemerkt auf tokenbasierte Abrechnung umstellen.

| Anbieter | CLI | Status |
|---|---|---|
| Anthropic Claude Code | `claude` | Lesen und Schreiben |
| OpenAI Codex | `codex` | nur unabhängiger Prüfer, nach bestandenem Isolations-Selbsttest |
| GitHub Copilot | `copilot` | nur Lesen, Abo von Ihnen bestätigt |
| Google Antigravity | `agy` | Planung, Review und Schiedsspruch — nachdem Sie das unten genannte Risiko akzeptiert haben |
| xAI Grok Build | `grok` | Planung, Review und Schiedsspruch, nach einem Isolations-Selbsttest |

Führen Sie `braingate providers list` aus, um zu sehen, welche Rolle jeder Anbieter auf Ihrem Rechner übernehmen darf und warum die geschlossenen geschlossen sind. Siehe **How a provider earns a role** in der englischen README dazu, wie ein Anbieter seine Rolle verdient und was Sie mit `braingate providers accept` akzeptieren.

## Installation

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck && pnpm test
```

Legen Sie `braingate` anschließend in den PATH. Der Starter ermittelt seinen eigenen Ort, ein
Symlink genügt also — nichts wird kopiert, nichts global installiert:

```bash
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
braingate
```

Der Symlink zeigt auf diese Arbeitskopie; der Befehl funktioniert nicht mehr, wenn das
Repository verschoben oder umbenannt wird oder auf einem nicht eingehängten Volume liegt.

## Schnellstart

**1. Sehen Sie, was BrainGate erkennt.** Melden Sie sich zuerst mit der CLI jedes Anbieters an
(`claude`, `codex login`, …), dann:

```bash
braingate discover
```

Authentifizierung, die sich nicht belegen lässt, wird als `unknown` gemeldet statt angenommen.

**2. Richten Sie den Modellkatalog ein.** BrainGate erfindet weder Modell-IDs noch
Kontextgrößen oder Fähigkeitswerte — Sie deklarieren die Modelle, zu denen geroutet wird. Der
Katalog ist **global**: einmal einrichten, alle Projekte nutzen ihn.

```bash
cat > claude-model.json <<'JSON'
{
  "providerId": "anthropic",
  "modelId": "<VON_IHNEN_GEPRUEFTE_MODELL_ID>",
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

Legen Sie pro gewünschtem Modell einen Eintrag an. `speed` ist `fast`, `balanced` oder `deep`
und ist der Hebel für „günstig zuerst": `fast` wird bei einfachen Aufgaben bevorzugt, `deep` bei
schweren. Die Werte sind Ihre Routing-Richtlinie — siehe
[`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md).

**3. Registrieren Sie ein Repository.**

```bash
cd /pfad/zu/ihrem/projekt
braingate init
```

Es schlägt anhand des Verzeichnisnamens eine Projekt-ID vor und lässt sie bestätigen. **Die ID
ist die Isolationsgrenze** — Speicher, Worktrees und Telemetrie hängen daran —, deshalb wählt
BrainGate sie nie stillschweigend. Mit `--project-id <id> --name <name>` überspringen Skripte
die Rückfrage.

**4. Prüfen Sie die Bereitschaft. Das kostet nichts.**

```bash
braingate dogfood preflight
```

**5. Stellen Sie eine Frage.** Planen Sie immer zuerst: Ein Plan ruft keinen Anbieter auf und
zeigt Ihnen Einstufung, das Modell, das laufen würde, und ob ein Prüfer nötig ist.

```bash
braingate dogfood ask plan --task "Wo ist die Theme-Konfiguration definiert?"
braingate dogfood ask run  --task "Wo ist die Theme-Konfiguration definiert?" --execute
```

**`--execute` ist das einzige Tor zu einem Modell.** Nichts davor verbraucht Kontingent.

**6. Halten Sie fest, was die Aufgabe tatsächlich war.** So verbessert sich das Routing.

```bash
braingate dogfood feedback --task-id <TASK_UUID> --actual-complexity T1 --outcome success
```

**7. Nehmen Sie eine kleine Änderung vor.** Schreibvorgänge brauchen eine saubere Arbeitskopie
und laufen in einem aufgabenspezifischen Worktree — nie in Ihrem Arbeitsbaum.

```bash
braingate dogfood write plan --task "Ändere das Empty-State-Label von X zu Y"
braingate dogfood write run  --task "Ändere das Empty-State-Label von X zu Y" --execute
```

Prüfen Sie den genannten Branch und mergen Sie ihn selbst, wenn er passt. **BrainGate merged,
pusht und deployt nichts.**

## Was es tut und was nicht

| Es tut | Es tut nie |
|---|---|
| Jede Aufgabe an das günstigste geeignete Modell routen | Anbieter-Token-Dateien lesen oder kopieren |
| Bei riskanter Arbeit einen unabhängigen Prüfer hinzuziehen | In Ihre Arbeitskopie schreiben — Änderungen gehen in einen Worktree |
| Hinterher prüfen, dass Ihre Arbeitskopie unverändert ist | Etwas mergen, pushen oder deployen |
| Verbrauch als `native` / `measured` / `estimated` / `unknown` kennzeichnen | Eine Schätzung als Messung ausgeben |
| Speicher, Worktrees und Telemetrie pro Projekt trennen | Kontext standardmäßig über Projektgrenzen tragen |
| Schreibvorgänge mit hohem Risiko sowie T3/T4 blockieren | Zugangsdaten, `.env`-Inhalte oder Geheimnisse im Speicher ablegen |

## Nachweisen, dass es wirklich funktioniert

`pnpm test` führt die gesamte Suite ohne Anbieteraufrufe aus. Das belegt BrainGates eigene Logik,
aber nicht, dass eine installierte CLI ein echtes Ergebnis geliefert hat. Zwei optionale
Integrationstests schließen diese Lücke, indem sie echte Anbieter gegen ein Wegwerf-Repository
laufen lassen:

```bash
pnpm test:integration
```

Sie verbrauchen echtes Abo-Kontingent und laufen nie in der CI. Führen Sie sie nach dem Update
einer Anbieter-CLI oder nach Änderungen an einem Anbieterprofil aus. Siehe
[`docs/DOGFOOD.md`](../DOGFOOD.md).

## Dokumentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | wie die Teile zusammenwirken |
| [`docs/SECURITY.md`](../SECURITY.md) | die Sicherheitsgrenzen und warum sie halten |
| [`docs/SAFE_EXECUTION.md`](../SAFE_EXECUTION.md) | Worktrees, Befehls-Allowlists, Fail-closed-Regeln |
| [`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) | wie eine Aufgabe eingestuft und geroutet wird |
| [`docs/DOGFOOD.md`](../DOGFOOD.md) | BrainGate an einem echten Repository erproben |
| [`docs/adr/`](../adr) | angenommene Architekturentscheidungen |

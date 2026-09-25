# BrainGate

**Un único plano de control local para las suscripciones de IA de programación que ya usas.**

BrainGate es un proyecto en fase pre-alfa que coordina las CLI oficiales de IA para programación
entre varios proyectos de software, manteniendo aislado el contexto de cada proyecto,
controlando el consumo de cuota y registrando lo que hizo cada agente.

> El inglés es la fuente de verdad: [`README.md`](../../README.md) · [`docs/GUIDE.md`](../GUIDE.md). Esta traducción cubre la
> instalación y el primer uso; el resto de la documentación en `docs/` está en inglés.

**Otros idiomas:**
[English](../../README.md) ·
[العربية](README.ar.md) ·
[Türkçe](README.tr.md) ·
[Français](README.fr.md) ·
[Deutsch](README.de.md) ·
[Português (BR)](README.pt-BR.md) ·
[Русский](README.ru.md) ·
[简体中文](README.zh-CN.md) ·
[日本語](README.ja.md) ·
[한국어](README.ko.md) ·
[हिन्दी](README.hi.md)

---

## Requisitos

| | |
|---|---|
| Node.js | 22 o superior |
| Git | cualquier versión reciente |
| pnpm | mediante Corepack (`corepack enable`) |
| Una CLI de proveedor | al menos una CLI oficial, con sesión iniciada en una suscripción tuya |

**BrainGate nunca pide una clave de API.** Ejecuta las CLI de proveedor en las que ya iniciaste
sesión y elimina de los subprocesos que lanza las variables conocidas de clave de API y de URL
base, de modo que un `ANTHROPIC_API_KEY` u `OPENAI_API_KEY` olvidado no pueda pasarte en
silencio a facturación por token.

| Proveedor | CLI | Estado |
|---|---|---|
| Anthropic Claude Code | `claude` | lectura y escritura |
| OpenAI Codex | `codex` | solo revisor independiente, tras una autoprueba de aislamiento |
| GitHub Copilot | `copilot` | solo lectura, con la suscripción declarada por ti |
| Google Antigravity | `agy` | planificación, revisión y arbitraje — tras aceptar el riesgo descrito abajo |
| xAI Grok Build | `grok` | planificación, revisión y arbitraje, tras una autoprueba de aislamiento |

Ejecuta `braingate providers list` para ver qué rol puede tomar cada proveedor en tu máquina y por qué los cerrados lo están. Consulta **How a provider earns a role** en el README en inglés para saber cómo un proveedor gana su rol y qué aceptas con `braingate providers accept`.

## Instalación

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck && pnpm test
```

Después pon `braingate` en el PATH. El lanzador resuelve su propia ubicación, así que basta con
un enlace simbólico: no se copia nada ni se instala nada de forma global.

```bash
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
braingate
```

El enlace apunta a esta copia del repositorio, por lo que el comando deja de funcionar si lo
mueves, lo renombras o vive en un volumen no montado.

## Inicio rápido

**1. Comprueba qué ve BrainGate.** Inicia sesión primero con la CLI de cada proveedor
(`claude`, `codex login`, …) y luego:

```bash
braingate discover
```

La autenticación que no se puede demostrar se informa como `unknown` en lugar de suponerse.

**2. Configura el catálogo de modelos.** BrainGate no inventa identificadores de modelo,
capacidades de contexto ni puntuaciones, así que tú declaras los modelos a los que enrutar. El
catálogo es **global**: se configura una vez y lo usan todos los proyectos.

```bash
cat > claude-model.json <<'JSON'
{
  "providerId": "anthropic",
  "modelId": "<ID_DE_MODELO_QUE_HAS_VERIFICADO>",
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

Añade una entrada por cada modelo que quieras disponible. `speed` es `fast`, `balanced` o
`deep`, y es la palanca de «lo barato primero»: `fast` se prefiere en tareas sencillas y `deep`
en las difíciles. Las puntuaciones son tu política de enrutado; consulta
[`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md).

**3. Registra un repositorio.**

```bash
cd /ruta/a/tu/proyecto
braingate init
```

Propone un identificador de proyecto a partir del nombre del directorio y te pide confirmación.
**El identificador es la frontera de aislamiento** —memoria, worktrees y telemetría se acotan
a él—, por eso BrainGate nunca elige uno en silencio. Usa `--project-id <id> --name <nombre>`
para omitir la pregunta en scripts.

**4. Comprueba que todo está listo. Esto no gasta nada.**

```bash
braingate dogfood preflight
```

**5. Haz una pregunta.** Planifica siempre primero: un plan no realiza ninguna llamada al
proveedor y te muestra la clasificación, qué modelo se ejecutaría y si hace falta un revisor.

```bash
braingate dogfood ask plan --task "¿Dónde se define la configuración del tema?"
braingate dogfood ask run  --task "¿Dónde se define la configuración del tema?" --execute
```

**`--execute` es la única puerta que llega a un modelo.** Nada anterior consume cuota.

**6. Registra en qué acabó siendo realmente la tarea.** Así mejora el enrutado.

```bash
braingate dogfood feedback --task-id <TASK_UUID> --actual-complexity T1 --outcome success
```

**7. Haz un cambio pequeño.** Las escrituras requieren una copia de trabajo limpia y se
realizan en un worktree propio de la tarea, nunca en tu árbol de trabajo.

```bash
braingate dogfood write plan --task "Cambia la etiqueta de estado vacío de X a Y"
braingate dogfood write run  --task "Cambia la etiqueta de estado vacío de X a Y" --execute
```

Revisa la rama que indica y fusiónala tú si te convence. **BrainGate no fusiona, no hace push
ni despliega.**

## Qué hace y qué no hace

| Hace | Nunca hace |
|---|---|
| Enruta cada tarea al modelo capaz más barato | Leer ni copiar los ficheros de credenciales del proveedor |
| Añade un revisor independiente en trabajo arriesgado | Escribir en tu copia de trabajo: los cambios van a un worktree |
| Verifica después que tu copia sigue intacta | Fusionar, hacer push o desplegar nada |
| Etiqueta el uso como `native` / `measured` / `estimated` / `unknown` | Presentar una estimación como una medición |
| Mantiene memoria, worktrees y telemetría por proyecto | Cruzar contexto entre proyectos por defecto |
| Bloquea escrituras de alto riesgo y de nivel T3/T4 | Guardar credenciales, contenido de `.env` o secretos en memoria |

## Comprobar que funciona de verdad

`pnpm test` ejecuta toda la batería sin llamadas al proveedor, lo que demuestra la lógica propia
de BrainGate pero no que una CLI instalada produjera un resultado real. Dos pruebas de
integración opcionales cubren ese hueco ejecutando proveedores reales contra un repositorio
desechable:

```bash
pnpm test:integration
```

Gastan cuota real de suscripción y nunca se ejecutan en CI. Lánzalas tras actualizar una CLI de
proveedor o tocar un perfil de proveedor. Consulta [`docs/DOGFOOD.md`](../DOGFOOD.md).

## Documentación

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | cómo encajan las piezas |
| [`docs/SECURITY.md`](../SECURITY.md) | los límites de seguridad y por qué se sostienen |
| [`docs/SAFE_EXECUTION.md`](../SAFE_EXECUTION.md) | worktrees, listas de comandos permitidos, reglas de cierre seguro |
| [`docs/ROUTING_AND_REVIEW.md`](../ROUTING_AND_REVIEW.md) | cómo se clasifica y enruta una tarea |
| [`docs/DOGFOOD.md`](../DOGFOOD.md) | probar BrainGate en un repositorio real |
| [`docs/adr/`](../adr) | decisiones de arquitectura aceptadas |

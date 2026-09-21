# OmniRoute + Claude Code — abilitare i modelli di ogni node

Questa è la parte che **non cambia la natura di Claude Code né dei modelli**.
Serve solo a far comparire nel picker `/model` di Claude Code i modelli di ogni
node OmniRoute, accanto a quelli Anthropic.

Verificato su OmniRoute v3.8.50 (npm) / v3.8.51 (repo).

---

## Il problema che risolve

Claude Code fa model discovery leggendo `/v1/models` dal gateway, ma **elenca solo
gli id che iniziano con `claude` o `anthropic`**. Quindi un `glm/glm-5.2` o un
`kimi/kimi-k2.6` non appare mai nel picker, anche se il routing funzionerebbe.

OmniRoute risolve con i **discovery alias**: rispecchia ogni modello abilitato
sotto un id `claude/…` che passa quel filtro.

```
kimi/kimi-k2.6             →  claude/kimi/kimi-k2.6
glm/glm-5.2                →  claude/glm/glm-5.2
combo "costo-ottimizzato"  →  claude/combo/costo-ottimizzato
```

**L'alias è solo un'etichetta.** Quando selezioni uno di questi, OmniRoute toglie
il prefisso `claude/` e instrada all'id reale prima della chiamata. Un id
`claude/<modello-claude-vero>` (il provider Claude OAuth) viene lasciato intatto.

> Riferimento nel codice: `src/sse/handlers/chat.ts:612-615` →
> `resolveCcDiscoveryAliasStrip(modelStr)`, che logga
> `Resolved cc discovery alias: <alias> → <id reale>`.

---

## Il gate a 3 livelli (abilita/disabilita ogni node)

È esattamente un on/off per node, con override per singolo modello.
**Vince il più specifico**, e un valore assente significa "eredita".

| Livello | Dove si imposta | Effetto |
|---|---|---|
| **Modello** | Provider detail page → toggle "Expose in Claude Code" sul modello | vince su tutto |
| **Node (provider)** | Provider detail page → toggle a livello provider | copre tutti i suoi modelli |
| **Globale** | Settings → Feature Flags → `EXPOSE_CC_DISCOVERY_ALIASES` | default **off** |

Il resolver è una funzione pura (`src/lib/db/ccDiscoveryAliases.ts`):

```ts
if (model    === "on")  return true;
if (model    === "off") return false;
if (provider === "on")  return true;
if (provider === "off") return false;
return global;
```

Quindi: **globale off + un solo node on** espone esclusivamente i modelli di
quel node. È il caso d'uso più pulito.

**Precedenza della variabile d'ambiente:** `EXPOSE_CC_DISCOVERY_ALIASES=1`
forza il livello globale a on e **vince sull'override del dashboard** (è
l'opposto della precedenza del generico `resolveFeatureFlag` — è documentato
e intenzionale). Il dashboard mostra "active via environment variable" quando
succede.

Persistenza: tabella `key_value`, namespace `ccDiscoveryAliases`, chiavi
`provider:<id>` e `model:<providerId>/<modelId>`, valori `"on"` / `"off"`.
Chiave assente = eredita.

---

## API per farlo da script

```bash
# Leggi lo stato di un node + tutti gli override dei suoi modelli
curl -H "Cookie: auth_token=<jwt>" \
  http://localhost:20128/api/providers/<providerId>/cc-alias
# → {"provider":"on"|"off"|null,"models":{"<modelId>":"on"|"off"}}
```

La rotta richiede management auth (`requireManagementAuth`): JWT di sessione
dashboard, token CLI locale, o un access token `oma_live_…` con lo scope giusto.
Una API key di inferenza `sk-…` **non** basta, a meno che non abbia scope
`manage`/`admin`.

---

## Configurazione di Claude Code

Claude Code parla l'API Messages di Anthropic e si punta a un endpoint custom
**solo via variabili d'ambiente** (non ha un flag `--base-url`).

`~/.claude/settings.json`:

```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:20128",
    "ANTHROPIC_AUTH_TOKEN": "<la tua API key OmniRoute>",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

| Variabile | Cosa fa |
|---|---|
| `ANTHROPIC_BASE_URL` | URL root del gateway. Claude Code ci appende `/v1/messages`. **Niente suffisso `/v1`, niente slash finale.** |
| `ANTHROPIC_AUTH_TOKEN` | Inviato come `Authorization: Bearer …` |
| `ANTHROPIC_API_KEY` | Alternativa, inviato come `x-api-key`. Se ci sono entrambi vince `ANTHROPIC_AUTH_TOKEN` |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` → il picker `/model` nativo elenca i modelli `claude*`/`anthropic*` da `/v1/models` |
| `ANTHROPIC_MODEL` | Forza un modello specifico |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Soglia token per l'auto-compaction |

> Le env var sono lette **una volta all'avvio**: riavvia Claude Code dopo ogni modifica.

Il dashboard genera già questo snippet per la tua istanza: **Dashboard → CLI Code**,
card di Claude, con pulsante copia. La chiave non viene mai renderizzata (c'è un
placeholder), quindi uno screenshot non la può leakare.

---

## ⚠️ Il tranello: finestra di contesto

Claude Code **assume 200K di context window per ogni id che non riconosce** — non
può leggere la finestra reale da `/v1/models`.

Per un modello con finestra più grande (es. Kimi K2 a 256K) imposta
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` a un valore **sotto** la finestra reale, così
l'auto-compaction non parte troppo presto (o troppo tardi).

---

## Scorciatoie CLI

```bash
omniroute launch                    # lancia Claude Code contro l'OmniRoute locale
omniroute launch --remote http://<host>:20128 --api-key oma_live_xxx
omniroute setup-claude              # genera ~/.claude/profiles/<nome>/settings.json
omniroute launch --profile glm52    # lancia con quel profilo
omniroute run claude --model openai/gpt-5.4
```

`setup-claude` legge il catalogo `/v1/models` live e scrive un profilo per
modello, già con il `CLAUDE_CODE_AUTO_COMPACT_WINDOW` corretto.
Il token di auth **non** viene mai scritto nel profilo: lo inietta `omniroute
launch`, oppure lo esporti tu e lanci
`CLAUDE_CONFIG_DIR=~/.claude/profiles/<nome> claude`.

I profili usano `CLAUDE_CONFIG_DIR` (Claude Code non ha profili nativi): ogni
profilo è una directory di config separata, con le sue credenziali, history e cache.

**Auto-sync opzionale:** OmniRoute può rigenerare i profili quando il catalogo
cambia. Off di default — si attiva da CLI Code dashboard ("CLI profile auto-sync")
o con `OMNIROUTE_AUTO_SYNC_CLAUDE_PROFILES=true`. Tocca solo i file di profilo:
non modifica mai la config attiva, l'auth o `~/.claude/settings.json`.

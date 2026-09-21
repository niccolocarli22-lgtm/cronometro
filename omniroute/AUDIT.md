# OmniRoute — verifica pratica

Test eseguiti il 2026-09-21 su container Linux, Node 22.22.2.
Repo: `diegosouzapw/OmniRoute` @ `06f1df9d` (v3.8.51) · npm: `omniroute@3.8.50`

---

## 1. Installazione

```
npm install -g omniroute   →  1137 pacchetti, 2 min, exit 0
```

| | |
|---|---|
| Spazio su disco | **2.7 GB** |
| Versione npm pubblicata | 3.8.50 |
| Versione nel repo | 3.8.51 |
| Node richiesto | `>=22.22.2 <23 \|\| >=24.0.0 <27` |

Il comando documentato in alcuni punti è `omniroute start`, ma **non esiste**:
è `omniroute serve`. `start` va in errore con un messaggio chiaro.

Al primo avvio genera automaticamente una `STORAGE_ENCRYPTION_KEY` in
`~/.omniroute/.env` — quindi il modulo di cifratura non resta in passthrough.

---

## 2. Il claim zero-config: **non ha funzionato**

Il README promette che dopo l'installazione `model: "auto"` risponde senza
chiavi né configurazione. Due tentativi indipendenti, stesso esito:

```
tentativo 1:
  oc/big-pickle          → 403  "OpenCode's free tier can only be used from within OpenCode"
  felo/felo-chat         → 400  "Felo thread creation failed"
  terminalReason         → 429

tentativo 2:
  oc/muse-spark-1.2      → 402  "This model requires an opencode API key"
  oc/…-contributor-free  → 403  "OpenCode's free tier can only be used from within OpenCode"
  felo/*                 → 400 / 429
```

`poolSize: 13`, tutti i tentativi falliti. `/v1/models` restituisce **0 modelli**
senza provider configurati.

Il provider keyless precablato nel combo `auto` è **OpenCode Free** — e nel
catalogo terms-risk dello stesso progetto è marcato **`avoid`**. Il provider sta
attivamente rilevando e bloccando l'uso fuori dal proprio client.

> **Attenuante onesta:** questo test parte da un IP datacenter dietro proxy. I
> provider keyless basati su scraping web bloccano abitualmente gli IP datacenter.
> Da una connessione domestica potrebbe funzionare. Ma "funziona appena lo
> installi" non regge come promessa incondizionata.

**Nota positiva:** il fallback si vede lavorare. L'errore restituisce
`attemptOrder` completo, motivi di esclusione per provider, `terminalReason` e
un `recovery_hint` azionabile. Diagnostica di ottima qualità.

---

## 3. Compressione: reale, ma il range va letto bene

Misurato via `/api/compression/preview` sull'istanza in esecuzione.
**15 engine registrati** (il README ne dichiara 12).

| Carico di lavoro | Engine | Token | Risparmio |
|---|---|---|---|
| Prosa prolissa/cortese | caveman | 82 → 52 | **37%** |
| Prompt tecnico asciutto | caveman | 45 → 40 | **11%** |
| Prompt con blocco di codice | caveman | 38 → 38 | **0%** |
| Output tool lungo e ripetitivo (300 righe) | rtk | 3012 → 822 | **73%** |

Il range "15–95%" è quindi **plausibile come intervallo tra carichi diversi**.
La media dichiarata di ~89% no: richiederebbe che quasi tutto il traffico fosse
output di tool altamente ripetitivo.

**Il blocco di codice è preservato correttamente** — 0% di risparmio, nessuna
corruzione. Comportamento giusto.

**Ma la compressione è lossy sul testo.** Regole applicate al prompt cortese:
`pleasantries, polite_framing, hedging, redundant_openers, excessive_gratitude,
redundant_directive, emphasis_removal, articles`. Risultato:

```
"Thank you so much, I really appreciate your help."
                    ↓
"So much, your help."
```

```
"Could you please take a look at it?"
                    ↓
"Take look at it?"
```

Il 37% si paga con inglese sgrammaticato. Su un prompt già scritto bene il
risparmio scende all'11% e resta semanticamente sicuro. Da valutare caso per caso.

---

## 4. Sicurezza

### 🔴 Password di default `CHANGEME`, stampata sulla pagina di login

La schermata di login dichiara testualmente:
`Default password: CHANGEME (unless INITIAL_PASSWORD was set)`.

**Verificato: funziona.** Login riuscito, atterrato su `/home` con sessione piena.

Il JWT di sessione è minimale: `{"authenticated":true,"exp":…}` — nessuna identità utente.

### 🔴 L'API di inferenza non è autenticata

`POST /v1/messages` e `/v1/chat/completions` **senza alcun cookie** → `502`, non `401`.
Cioè la richiesta arriva al layer di routing.

Il dashboard è protetto (307 → `/login`) e `/api/free-tier/summary` risponde `401`.
Ma il path di inferenza è aperto.

**Perché conta:** il progetto documenta esplicitamente una "Remote mode — OmniRoute
su un VPS". Chi espone la porta 20128 senza mettere mano a password e auth regala
a chiunque il proprio gateway — e quindi le proprie chiavi API e quote.

### 🔴 Aggiramento del bot-detection di claude.ai

`open-sse/services/claudeTurnstileSolver.ts` — dal suo stesso header:

```
Cloudflare Turnstile Solver for Claude Web
1. Launches a headless Playwright browser
2. Navigates to claude.ai
3. Waits for Turnstile challenge to appear
4. Waits for challenge to be solved (with retry)
5. Extracts cf_clearance cookie
6. Returns a fresh cookie for the isolated wreq-js request
```

Più `claudeWebAutoRefresh.ts` (cache del token 55 min, iniezione in cookie
esistenti) e `claudeWebFingerprint.ts`. `wreq-js` fa impersonation del
fingerprint TLS JA3/JA4.

In chiaro: instrada attraverso sessioni web consumer di claude.ai aggirando la
protezione Cloudflare. Viola i ToS di Anthropic e mette a rischio la sospensione
dell'account. Analogo per Grok (`grokClearance.ts`).

Non è codice malevolo — non esfiltra nulla — ma è circumvention deliberata.
**È opt-in:** si attiva solo configurando quel provider.

### ✅ Note positive

- `src/lib/db/encryption.ts` è scritto con competenza: AES-256-GCM, `authTagLength`
  fissato a 16 byte per chiudere il vettore di forgery da truncation della tag GCM,
  migrazione automatica dalle chiavi legacy, dedupe dei log di errore.
- Chiave di cifratura generata automaticamente al primo avvio.
- Il dashboard è auth-gated di default.
- Quattro famiglie di credenziali separate e non intercambiabili
  (`docs/guides/MANAGEMENT-AUTH.md`), con scope distinti.

### ⚠️ Nit su `encryption.ts`

`encrypt()` in caso di errore **ritorna il plaintext** invece di fallire
(riga ~200: `return plaintext; // fallback to plaintext rather than crashing`).
Un errore di cifratura salva quindi il segreto in chiaro, con solo un
`console.error`. Fail-open su un path che tratta chiavi API.

---

## 5. Claim verificati

| Claim | Esito |
|---|---|
| 39.000+ test declarations | ✅ **43.646** `it(`/`test(` contati — sottostimato |
| 5.100+ file di test | ✅ **6.168** file — sottostimato |
| 19 routing strategies | ✅ 20 valori in `ROUTING_STRATEGY_VALUES` + 1 interna (`quota-share`) |
| 12 engine di compressione | ✅ **15** registrati a runtime — sottostimato |
| 100% TypeScript | ✅ coerente con l'esplorazione |
| ~1.62B token/mese gratis | ⚠️ l'API live calcola **1.508.225.000** (~1.51B), non 1.62B |
| Funziona zero-config | ❌ vedi §2 |
| Risparmio medio ~89% | ⚠️ non riproducibile — vedi §3 |

Il progetto **sottostima** sistematicamente i propri numeri tecnici verificabili
(test, engine, strategie) e **sovrastima** quelli commerciali (token gratis,
risparmio medio, zero-config).

---

## 6. Il punto sui ToS

Il catalogo `docs/reference/FREE_TIERS.md` marca ogni provider con un verdetto:
`ok` / `caution` / `ambiguous` / `unknown` / `avoid`. **13 provider sono `avoid`**,
tra cui `opencode`, `t3-web`, `agy`, `blackbox`, `duckduckgo-web`, `kiro`,
`fireworks`, `ai21`.

Ma i docs stessi (riga 103) chiariscono:

> **ToS flag is advisory, not a routing gate.** Providers marked `tos` are still
> included in routing and combo/fallback by default; the flag only surfaces on
> `/dashboard/free-tiers` and `/api/free-tier/summary`. The verdict lives in
> `open-sse/config/freeTierCatalog.ts` (informational, not read by routing engines).

**Verificato:** `freeTierCatalog` è importato da **un solo file**,
`open-sse/config/freeModelCatalog.ts`. Nessun engine di routing lo legge.

Quindi il "così decidi tu" del README è vero solo se vai a leggere la tabella:
il flag non blocca nulla, e il default instrada comunque sui provider `avoid`.

---

## Giudizio

Ingegneria seria. 26k righe di sola compressione, 6.168 file di test, un registry
a plugin pulito, un resolver di precedenza come funzione pura, diagnostica di
fallback di qualità rara. Chi lo ha scritto sa fare il suo mestiere.

Il marketing però va oltre il prodotto, e i tre problemi di sicurezza sono reali.

**Se lo usi:**
1. Cambia subito la password — `CHANGEME` è pubblica e funzionante
2. Non esporre la porta 20128 fuori da localhost senza metterci auth davanti
3. Tieni `STORAGE_ENCRYPTION_KEY` impostata (di default lo è)
4. Leggi la tabella terms-risk e disattiva a mano i provider `avoid` che non
   vuoi toccare: il flag da solo non li blocca
5. Evita i provider claude-web / grok-web se tieni agli account
6. Aspettati di dover configurare almeno un provider con chiave — lo zero-config
   non ha risposto

**Come vale la pena usarlo:** con provider a chiave tua (Groq, Mistral, DeepSeek,
Cerebras — free tier ufficiali e dichiarati, senza scraping), sfruttando fallback,
routing e compressione RTK sugli output dei tool. Lì il valore è reale e i ToS
sono puliti.

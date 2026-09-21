# OmniRoute — cosa devi fare davvero per usarlo

Guida pratica, dopo averlo installato e testato sul serio.
Vedi `AUDIT.md` per i test, `CLAUDE-CODE-SETUP.md` per il dettaglio Claude Code.

---

## ⚠️ Prima di tutto: mettiamo in chiaro cosa NON fa

**OmniRoute non ti dà Claude gratis.** Questo è il malinteso più comune e va
tolto di mezzo subito.

Se punti Claude Code su OmniRoute, continui a usare l'**interfaccia** di Claude
Code — ma i modelli che rispondono sono **altri**: GLM, Kimi, DeepSeek, Qwen,
Llama. Non Opus, non Sonnet.

Quindi se stai per esaurire gli utilizzi, OmniRoute ti serve a:

- ✅ **avere un fallback** quando finisci il piano — continui a lavorare su
  modelli diversi invece di fermarti
- ✅ **spostare il lavoro di routine** (commit message, rinomina variabili,
  boilerplate, test banali) su modelli gratuiti, risparmiando il piano Claude
  per quello che conta
- ✅ **comprimere gli output dei tool** — qui il risparmio è reale (73% misurato)
- ❌ **non** ti dà Claude gratis o illimitato

L'unico modo per usare Claude *vero* attraverso OmniRoute è il provider
claude-web, che aggira la protezione Cloudflare di claude.ai. **Non farlo:**
viola i ToS e ti fai sospendere l'account. Ironia: perderesti anche gli utilizzi
che stai cercando di risparmiare.

---

## Passo 1 — Installa

```bash
npm install -g omniroute     # ~2 min, 2.7 GB su disco
omniroute serve              # NON "omniroute start", non esiste
```

Si apre su `http://localhost:20128`. Al primo avvio genera da solo una
`STORAGE_ENCRYPTION_KEY` in `~/.omniroute/.env` — le chiavi che inserirai
saranno cifrate a riposo.

Serve Node `>=22.22.2 <23` oppure `>=24 <27`.

## Passo 2 — Metti in sicurezza (2 minuti, non saltarlo)

**a) Cambia la password.** Quella di default è `CHANGEME` ed è scritta sulla
pagina di login. Dashboard → Settings, oppure `omniroute-reset-password`.

**b) Non esporre la porta 20128.** L'API di inferenza risponde **senza
autenticazione**. Su localhost va bene. Se la metti su un VPS o la apri sulla
rete di casa, chiunque può usare il tuo gateway — e quindi le tue chiavi e le
tue quote. Se ti serve da remoto: VPN o tunnel SSH, non porta aperta.

```bash
# tunnel SSH dal portatile al VPS — il modo giusto
ssh -L 20128:localhost:20128 utente@tuo-vps
```

## Passo 3 — Aggiungi provider con le TUE chiavi

Questo è il punto che fa la differenza tra "funziona" e "non funziona".

I provider keyless precablati **non hanno funzionato** nei miei test: OpenCode
Free risponde `403 — can only be used from within OpenCode`. Non contarci.

Registrati e prendi le chiavi tu. Dashboard → Providers → aggiungi la chiave.

| Provider | Free tier | Perché vale |
|---|---|---|
| **Groq** | ~30M token/mese | Velocissimo. Llama, Qwen, Kimi K2 |
| **Mistral** | ~1B token/mese | La quota più generosa in assoluto. Codestral è buono per il codice |
| **Google AI Studio** | Gemini, quota giornaliera | Finestra di contesto enorme |
| **Cerebras** | $5 di credito | Inferenza rapidissima |
| **DeepSeek** | ~5M di credito | Ottimo rapporto qualità/prezzo sul codice |
| **Scaleway** | ~1M | Europeo, verdetto ToS `ok` |

**Sui ToS, la versione onesta.** Nel catalogo del progetto questi sono marcati
`caution`, non `ok`. Il motivo è sempre lo stesso: i loro ToS vietano di
**rivendere o dare accesso a terzi** alle API. Un gateway personale, monoutente,
sulla tua macchina, con le tue chiavi, non è rivendita — sei tu che usi il tuo
account. La riga la superi se **condividi il gateway con altri**. Non farlo e
resti nel ragionevole.

I 13 provider marcati `avoid` sono un'altra storia (scraping di interfacce web,
aggiramento di protezioni). **Attenzione: il flag `avoid` non blocca niente** —
l'ho verificato nel codice, il routing li usa lo stesso. Disattivali a mano:
Dashboard → Providers → disabilita.

## Passo 4 — Collega Claude Code

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

⚠️ Niente `/v1` alla fine dell'URL e niente slash finale — Claude Code ci
appende `/v1/messages` da solo.

Poi abilita i **discovery alias**, altrimenti nel picker `/model` non vedi nulla
oltre ai modelli Anthropic: Settings → Feature Flags → `EXPOSE_CC_DISCOVERY_ALIASES`.
Oppure, più pulito, tieni il globale off e accendi **un node alla volta** dalla
sua pagina provider. Dettaglio completo in `CLAUDE-CODE-SETUP.md`.

⚠️ **Il tranello della finestra di contesto.** Claude Code assume 200K per ogni
modello che non conosce. Per Kimi K2 (256K) aggiungi:

```jsonc
"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "240000"
```

Senza, l'auto-compaction parte quando non deve.

**Le env var sono lette all'avvio:** riavvia Claude Code dopo ogni modifica.

### Il modo più comodo: due profili affiancati

Non sostituire la tua configurazione Claude. Tienile separate:

```bash
omniroute setup-claude           # genera un profilo per modello
omniroute launch --profile glm52 # lancia Claude Code su quel profilo
```

Così `claude` da solo resta il tuo Claude normale, e `omniroute launch
--profile <nome>` è il fallback su modelli gratuiti. Passi dall'uno all'altro
senza toccare niente.

## Passo 5 — Accendi la compressione dove paga

Questi sono i risparmi che ho **misurato**, non quelli dichiarati:

| Dove | Risparmio reale |
|---|---|
| Output dei tool lunghi e ripetitivi (**RTK**) | **73%** ✅ |
| Prompt in prosa prolissa (caveman) | 37%, ma rovina il testo ⚠️ |
| Prompt tecnici asciutti (caveman) | 11% |
| Prompt con codice | 0% — il codice è preservato ✅ |

**Consiglio: accendi RTK, lascia caveman spento.**

RTK lavora sugli output dei tool — `ls -R`, log, `npm install`, diff lunghi — che
è esattamente ciò che riempie il contesto quando programmi. Lì il 73% è vero e
non perdi niente di semantico.

Caveman invece riscrive il tuo testo e lo degrada:

```
"Thank you so much, I really appreciate your help."
        ↓
"So much, your help."
```

Il 37% si paga in inglese sgrammaticato. Su un prompt già scritto bene comunque
recuperi solo l'11%.

`Dashboard → Context → RTK` per configurarlo.

---

## Riassunto operativo

```bash
npm install -g omniroute
omniroute serve
# 1. cambia la password CHANGEME
# 2. aggiungi Groq + Mistral con le tue chiavi
# 3. disattiva i provider marcati "avoid"
# 4. accendi RTK, lascia caveman spento
# 5. abilita i discovery alias sui node che vuoi vedere
omniroute setup-claude
omniroute launch --profile <nome>
```

## Le cinque cose da non fare

1. **Non lasciare `CHANGEME`** — è pubblica e funziona
2. **Non esporre la porta 20128** — l'API di inferenza non ha autenticazione
3. **Non usare i provider claude-web / grok-web** — aggirano il bot-detection,
   rischi la sospensione dell'account
4. **Non condividere il gateway con altri** — è lì che violi davvero i ToS dei
   provider, non nell'uso personale
5. **Non aspettarti che lo zero-config funzioni** — servono le tue chiavi

## Aspettativa realistica

Un fallback solido e un buon risparmio di contesto, in cambio di mezz'ora di
configurazione e di modelli meno capaci di Opus.

Non è Claude gratis. È "non mi fermo quando finisco il piano", e per lavoro di
routine spesso basta.

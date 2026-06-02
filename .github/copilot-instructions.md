---
applyTo: "**"
---

# PBIP Documenter

Dette repoet inneholder et CLI-verktøy som genererer dokumentasjon for Power BI PBIP-prosjekter (TMDL semantic models + PBIR visuals).

## Kjøre verktøyet

Brukere kan generere dokumentasjon med én kommando — ingen installasjon nødvendig:

```powershell
npx github:bredeespelid/PBIP_SemLin "C:\path\to\MinRapport"
```

### Eksempler

```powershell
# Markdown (standard)
npx github:bredeespelid/PBIP_SemLin "C:\path\to\MinRapport"

# JSON-format
npx github:bredeespelid/PBIP_SemLin "C:\path\to\MinRapport" --format json

# HTML
npx github:bredeespelid/PBIP_SemLin "C:\path\to\MinRapport" --format html

# Kun semantic model (uten visuals)
npx github:bredeespelid/PBIP_SemLin "C:\path\to\MinRapport" --scope model

# Eget filnavn
npx github:bredeespelid/PBIP_SemLin "C:\path\to\MinRapport" --out docs.md
```

### Flagg
| Flagg | Verdier | Standard |
|---|---|---|
| `--format` | `md`, `json`, `html` | `md` |
| `--scope` | `model`, `visuals`, `all` | `all` |
| `--out` | filsti | `<ModelName>-docs.<ext>` i PBIP-mappen |

### Krav
- Node.js 18+
- PBIP-mappen må inneholde en `*.SemanticModel`-undermappe med TMDL-filer

## Hva dokumentasjonen inneholder

- **Tabeller** — kolonner, datatyper, nøkler, skjulte felt
- **Measures** — DAX-uttrykk, formateringsstrenger
- **Relasjoner** — kardinalitet, kryss-filter-retning
- **Datakilder** — SQL Server, Azure, Snowflake, BigQuery, m.fl. (20+ konnektorer)
- **Visuals** — hvilke felt/measures brukes i hvilke visuals per rapport-side
- **Lineage** — sporbarhet fra datakilder → tabeller → measures → visuals
- **Field parameters** og **calculation groups** identifisert og dokumentert

## Filstruktur (for utvikling)

```
generate-docs.js      ← CLI entry point (npx kjører denne)
tmdl-parser.js        ← TMDL state machine parser
m-parser.js           ← M/Power Query expression parser
visual-parser.js      ← PBIR visual.json parser
lineage-engine.js     ← Avhengighetsgraf
doc-generator.js      ← Output-formattering (Markdown, HTML, JSON)
index.html            ← Nettleser-app (åpne direkte i Chrome/Edge)
mcp-server/           ← MCP-server for agent-integrasjon
```

## Når en bruker spør om dokumentasjon av en PBIP-fil

Hjelp dem med å:
1. Identifisere sti til PBIP-mappen
2. Kjøre `npx`-kommandoen over
3. Åpne den genererte `.md`/`.json`/`.html`-filen

Hvis de jobber i dette repoet direkte kan de også bruke VS Code-tasken:
`Ctrl+Shift+P` → **Tasks: Run Task** → **Generate PBIP Docs**

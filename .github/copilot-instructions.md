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

---

## Bygg dashboard — prototype og Fabric Data App

Etter at en PBIP-modell er lastet i nettleserappen kaller pbip-documenter-agenten `app.buildDashboard()` via JavaScript i nettleseren. Det finnes ingen synlig knapp — funksjonen er agent-styrt. Folder-velgeren (File System Access API) åpnes for brukeren.

### Hva som skrives til disk

Brukeren velger en mappe via folder-velgeren. To filer skrives:

**`model-ctx.md`** — Copilot-kontekst for videre utvikling:
- Alle tabeller med kolonner og datatyper
- Alle measures med fulle DAX-uttrykk
- Alle relasjoner med kardinalitet og kryss-filter-retning
- Datakilder med konnektortype og fysisk tabellnavn
- Notater om hva feltnavnene heter i DAX

**`dashboard.html`** — Selvinneholdt prototyp-dashboard:
- Ingen server nødvendig — fungerer på `file://` og VS Code Live Preview
- `const MODEL = {...}` JSON øverst inneholder all modelldata hentet fra in-memory modell
- D3.js (lastet fra cdnjs CDN) rendrer KPI-kort, søylediagram og relasjonsdiagram
- KPI-kort viser top-3 measures etter visual coverage; verdier er `—` (ingen DAX-engine i browser)
- Søylediagram: measures per tabell
- Force-diagram: tabeller som noder, relasjoner som kanter

### Utviklingsflyt

1. Åpne `dashboard.html` i **VS Code Live Preview**
2. Iterer med GitHub Copilot — alle feltnavn er i `model-ctx.md` og `const MODEL`
3. Copilot vil lese `model-ctx.md` automatisk som kontekst
4. Si **"I'm done"** → agenten kaller `app.scaffoldRayfin()` og scaffolder et Rayfin Fabric Data App-prosjekt

### "I'm done" — Rayfin scaffold-trigger

Når brukeren sier "I'm done", kaller pbip-documenter-agenten `app.scaffoldRayfin()` via JavaScript i nettleseren (se "Scaffold Rayfin" under). Den gjenbruker mappen som allerede ble valgt i `buildDashboard()`.

Rayfin-prosjektet frøes med:
- `fabric.yaml` med workspace + modell-tilkobling
- `AGENTS.md` som peker på `model-ctx.md` som modellkontekst
- Én `.dax` + `.json` + `.ts` per top-5 measure etter visual coverage
  (bruk kun kolonne- og measurenavn fra `model-ctx.md` — aldri oppfinn navn)

Lokal utvikling: `bun install && bun run dev` (localhost:5173, spørrer live modell)
Deploy: `bunx rayfin up`

### Scaffold Rayfin

Agenten kaller `app.scaffoldRayfin()` via JavaScript i nettleseren etter at `buildDashboard()` har lykkes.
Den gjenbruker den allerede valgte mappen (`_dashboardDirHandle`) — ingen ny mappevelger.
Etter scaffold: `bun install && bun run dev` i den genererte mappen starter lokal preview på localhost:5173.

### D3 drilldown og matriser

Alle tre scaffold-filene støtter avanserte D3-mønstre:

**Drilldown** (`d3.hierarchy()`):
- Lag én `.dax`-fil per nivå med `<LEVEL>`-placeholder (f.eks. Year → Quarter → Month)
- `.ts`-filen håndterer klikk-state og bytter `.dax`-fil ved drill
- `.json`-spec: `"drilldown": { "enabled": true, "levels": ["Year","Quarter","Month"], "placeholder": "<LEVEL>" }`

**Matrise / pivot** (`d3.rollup()`):
- `d3.rollup(data, v => d3.sum(v, d => d.Value), d => d.Row, d => d.Col)` for aggregering
- Ekspandert-rad-state holdes i `.ts`-filen
- DAX: `SUMMARIZECOLUMNS(RowDim, ColDim, "Value", [Measure])` — ingen pivot-funksjon nødvendig

**Kryssfiltrering mellom visuals**: bytt ut `<FILTER>`-placeholder med en `KEEPFILTERS(CALCULATETABLE(...))`-expression generert i `.ts`.

### Kildekode

```
src/dashboard-generator.js   ← generateModelContext() + generateDashboard()
src/fabric-scaffolder.js     ← FabricScaffolder.scaffold() — genererer alle Rayfin-filer
src/app.js                   ← buildDashboard() + scaffoldRayfin() — File System Access API write
```

Alle nye kildefiler legges i `src/` og lastes via `<script>` i `index.html` i riktig avhengighetsrekkefølge.

### Fabric Data Apps (ny juni 2026)

En Fabric Data App er en webapp hostet i Microsoft Fabric som spørrer en semantisk modell via `executeQueries` DAX API — som en Power BI-rapport, men bygget helt i kode. Rayfin CLI (`@microsoft/rayfin`) håndterer scaffolding, lokal dev og deploy.

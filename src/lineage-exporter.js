/**
 * LineageExporter
 * Builds AI-context JSON from parsed model + lineage engine.
 * Uses model.tables directly (like ontology-view.js) — no getFieldLineage() calls.
 * Data sources resolved via lineageEngine.edges (connects_to_source).
 */
const LineageExporter = {

    toAIContext(model, visualData, lineageEngine) {
        const modelName = model.database?.name || model.model?.name || 'Semantic Model';
        const tables = (model.tables || []).filter(t => !t._isAutoDate);

        // ── 1. Build table → sources map from edges ──────────────────────────────
        // Same approach lineage-diagram.js uses: iterate engine.edges for connects_to_source
        const tableSourceMap = {};  // tableName → [{ type, server, database, physicalSchema, physicalTable }]
        if (lineageEngine && lineageEngine.edges) {
            for (const edge of lineageEngine.edges) {
                if (edge.type !== 'connects_to_source') continue;
                const tblNode = lineageEngine.nodes.get(edge.from);
                const srcNode = lineageEngine.nodes.get(edge.to);
                if (!tblNode || !srcNode) continue;
                const tName = tblNode.name;
                if (!tableSourceMap[tName]) tableSourceMap[tName] = [];
                tableSourceMap[tName].push({
                    type: srcNode.sourceType || null,
                    server: srcNode.serverResolved || srcNode.server || srcNode.url || srcNode.path || null,
                    database: srcNode.databaseResolved || srcNode.database || null,
                    physicalSchema: edge.physicalSchema || null,
                    physicalTable: edge.physicalTable || null
                });
            }
        }

        // ── 2. Build physical column map from maps_to_physical_column edges ───────
        const physColMap = {};  // "tableName.colName" → { physicalColumn, physicalTable, physicalSchema }
        if (lineageEngine && lineageEngine.edges) {
            for (const edge of lineageEngine.edges) {
                if (edge.type !== 'maps_to_physical_column') continue;
                const colNode = lineageEngine.nodes.get(edge.from);
                const physNode = lineageEngine.nodes.get(edge.to);
                if (!colNode || !physNode) continue;
                physColMap[`${colNode.table}.${colNode.name}`] = {
                    physicalColumn: physNode.name,
                    physicalTable: physNode.physicalTable || null,
                    physicalSchema: physNode.physicalSchema || null
                };
            }
        }

        // ── 3. Build measure → pages map from visualData.fieldUsageMap ───────────
        const measurePageMap = {};  // "tableName.measureName" → [pageName, ...]
        if (visualData && visualData.fieldUsageMap) {
            for (const [key, usages] of Object.entries(visualData.fieldUsageMap)) {
                if (!key.startsWith('measure|')) continue;
                const [, tbl, fld] = key.split('|');
                const pages = [...new Set((usages || []).map(u => u.pageName).filter(Boolean))];
                if (pages.length) measurePageMap[`${tbl}.${fld}`] = pages;
            }
        }

        // ── 4. Build catalog from model.tables (like ontology-view.js) ───────────
        const catalog = tables.map(table => {
            const tObj = {
                name: table.name,
                isHidden: !!table.isHidden,
                isCalcGroup: !!table._isCalcGroup,
                isFieldParameter: !!table._isFieldParameter
            };
            if (table.description) tObj.description = table.description;

            const tSources = tableSourceMap[table.name] || [];
            if (tSources.length) tObj.dataSources = tSources;

            if (table.hierarchies && table.hierarchies.length > 0) {
                tObj.hierarchies = table.hierarchies.map(h => ({
                    name: h.name,
                    levels: (h.levels || []).map(l => l.name)
                }));
            }

            tObj.columns = table.columns.filter(c => !c.isHidden).map(col => {
                const cObj = { name: col.name, dataType: col.dataType || null };
                if (col.description) cObj.description = col.description;
                const phys = physColMap[`${table.name}.${col.name}`];
                if (phys) cObj.physicalMapping = phys;
                return cObj;
            });

            tObj.measures = table.measures.map(m => {
                const mObj = { name: m.name };
                if (m.description)   mObj.description   = m.description;
                if (m.displayFolder) mObj.displayFolder = m.displayFolder;
                if (m.formatString)  mObj.formatString  = m.formatString;
                if (m.expression)    mObj.expression    = m.expression.trim();

                // DAX refs from measureRefs (plain object keyed by measure name)
                const refs = lineageEngine && lineageEngine.measureRefs
                    ? lineageEngine.measureRefs[m.name]
                    : null;
                if (refs) {
                    if (refs.columnRefs && refs.columnRefs.length) {
                        mObj.columnDependencies = refs.columnRefs.map(r => `${r.table}[${r.column}]`);
                    }
                    if (refs.measureRefs && refs.measureRefs.length) {
                        mObj.measureDependencies = refs.measureRefs;
                    }
                }

                // Data sources: from this table's sources
                if (tSources.length) mObj.dataSources = tSources;

                // Pages that use this measure
                const usedOnPages = measurePageMap[`${table.name}.${m.name}`];
                if (usedOnPages) mObj.usedOnPages = usedOnPages;

                return mObj;
            });

            // Calculation group items (time intelligence variants etc.)
            if (table.calculationGroup && table.calculationGroup.items?.length) {
                tObj.calculationGroupItems = table.calculationGroup.items
                    .sort((a, b) => (a.ordinal ?? 99) - (b.ordinal ?? 99))
                    .map(item => {
                        const ci = { name: item.name };
                        if (item.expression) ci.expression = item.expression.trim();
                        if (item.formatStringExpression) ci.formatStringExpression = item.formatStringExpression.trim();
                        return ci;
                    });
            }

            return tObj;
        });

        // ── 5. Relationships ──────────────────────────────────────────────────────
        const relationships = (model.relationships || []).map(r => ({
            from: `${r.fromTable}[${r.fromColumn}]`,
            to: `${r.toTable}[${r.toColumn}]`,
            cardinality: r.cardinality || null,
            crossFilter: r.crossFilteringBehavior || null,
            isActive: r.isActive !== false
        }));

        // ── 6. RLS roles ──────────────────────────────────────────────────────────
        const roles = (model.roles || []).map(r => ({
            name: r.name,
            tableFilters: (r.modelPermissions || []).map(mp => ({
                tables: mp.targetTables || [],
                filter: mp.expression || null
            }))
        }));

        // ── Build lookup maps for descriptions (used in page enrichment) ─────────
        const measureDescMap = {};   // "table|name" → description
        const measureExprMap = {};   // "table|name" → expression (first line only)
        const columnDescMap  = {};   // "table|name" → description
        const tableDescMap   = {};   // tableName → description
        for (const t of catalog) {
            if (t.description) tableDescMap[t.name] = t.description;
            for (const m of (t.measures || [])) {
                const k = `${t.name}|${m.name}`;
                if (m.description) measureDescMap[k] = m.description;
                if (m.expression) measureExprMap[k] = m.expression.split('\n')[0].trim();
            }
            for (const c of (t.columns || [])) {
                if (c.description) columnDescMap[`${t.name}|${c.name}`] = c.description;
            }
        }

        // ── 7. Report pages (bonus — only if visual data loaded) ─────────────────
        const pages = [];
        if (visualData && visualData.pages) {
            for (const page of visualData.pages) {
                const pName = page.displayName || page.name || '';
                if (/^tooltip:/i.test(pName)) continue;
                const measuresOnPage = [];
                const tablesOnPage = new Set();

                const visuals = (page.visuals || []).map(visual => {
                    const fields = (visual.fields || []).map(field => {
                        const tName = field.table || '';
                        const fName = field.name || field.column || '';
                        tablesOnPage.add(tName);
                        const k = `${tName}|${fName}`;
                        const isMeasure = !!measureExprMap[k] || catalog.some(t => t.name === tName && t.measures.some(m => m.name === fName));
                        if (isMeasure) measuresOnPage.push(fName);
                        const fObj = { name: fName, type: isMeasure ? 'measure' : 'column', table: tName };
                        const desc = measureDescMap[k] || columnDescMap[k];
                        if (desc) fObj.description = desc;
                        return fObj;
                    }).filter(f => f.name);
                    const v = { visualType: visual.visualType || 'unknown', fields };
                    if (visual.visualName) v.visualName = visual.visualName;
                    return v;
                });

                const srcOnPage = [...tablesOnPage]
                    .flatMap(t => tableSourceMap[t] || [])
                    .filter((s, i, a) => a.findIndex(x => x.type === s.type && x.physicalTable === s.physicalTable) === i);

                const uniqueMeasures = [...new Set(measuresOnPage)];
                const uniqueTables   = [...tablesOnPage].filter(t => t);

                // Build a rich natural-language summary from available metadata
                const pageName = page.displayName || page.name;
                const srcTypes = [...new Set(srcOnPage.map(s => s.type))];

                // Measure descriptions for the summary (first 3 with descriptions)
                const mDescs = uniqueMeasures
                    .map(mn => {
                        const tbl = catalog.find(t => t.measures.some(m => m.name === mn));
                        const k = tbl ? `${tbl.name}|${mn}` : null;
                        return k ? measureDescMap[k] : null;
                    })
                    .filter(Boolean)
                    .slice(0, 3);

                // Table descriptions for context
                const tDescs = uniqueTables
                    .map(t => tableDescMap[t])
                    .filter(Boolean)
                    .slice(0, 2);

                const summaryParts = [
                    `Rapport-side: "${pageName}".`,
                    uniqueMeasures.length
                        ? `Nøkkeltall: ${uniqueMeasures.slice(0, 5).join(', ')}.`
                        : null,
                    mDescs.length
                        ? `Hva de måler: ${mDescs.join(' / ')}.`
                        : null,
                    tDescs.length
                        ? `Datatabeller: ${tDescs.join(' / ')}.`
                        : null,
                    srcTypes.length
                        ? `Datakilder: ${srcTypes.join(', ')}.`
                        : null,
                    page.isDrillthrough
                        ? 'Denne siden er et drillthrough-mål (detaljvisning).'
                        : null
                ].filter(Boolean);

                const summary = summaryParts.join(' ');

                const pObj = {
                    id: page.id,
                    name: pageName,
                    isDrillthrough: !!page.isDrillthrough,
                    visualCount: visuals.length,
                    summary,
                    visuals,
                    allMeasures: uniqueMeasures,
                    allTables: uniqueTables,
                    allDataSources: srcOnPage
                };
                if (page.filterConfig) pObj.filterConfig = page.filterConfig;
                if (page.isDrillthrough && page.drillthroughFilters) pObj.drillthroughFilters = page.drillthroughFilters;
                pages.push(pObj);
            }
        }

        return {
            model: {
                name: modelName,
                generatedAt: new Date().toISOString(),
                tableCount: tables.length,
                measureCount: tables.reduce((s, t) => s + t.measures.length, 0),
                relationshipCount: relationships.length,
                pageCount: pages.length
            },
            catalog,
            relationships,
            roles,
            pages
        };
    },

    toPreviewRows(aiContext, _model, _lineageEngine, limit = 60) {
        const rows = [];

        // From report pages (if present)
        for (const page of (aiContext.pages || [])) {
            for (const visual of page.visuals || []) {
                for (const field of visual.fields || []) {
                    if (field.type !== 'measure') continue;
                    const srcLabel = (field.dataSources || [])
                        .map(s => [s.type, s.physicalTable].filter(Boolean).join('.'))
                        .join(', ') || '—';
                    rows.push({ page: page.name, visual: visual.visualName || visual.visualType, measure: field.name, table: field.table, source: srcLabel });
                    if (rows.length >= limit) return rows;
                }
            }
        }

        // Fallback: catalog measures (always present)
        if (rows.length === 0) {
            for (const tableEntry of (aiContext.catalog || [])) {
                for (const m of (tableEntry.measures || [])) {
                    const srcLabel = (m.dataSources || [])
                        .map(s => [s.type, s.physicalTable].filter(Boolean).join('.'))
                        .join(', ') || '—';
                    rows.push({ page: '(Modell)', visual: '—', measure: m.name, table: tableEntry.name, source: srcLabel });
                    if (rows.length >= limit) return rows;
                }
            }
        }

        return rows;
    },

    // ── Index export (level 1) — star schema ─────────────────────────────────
    // Returns flat dimension + bridge tables ready for Power BI or a vector store.
    // Relationships: dim_workspace (1) → dim_report (many) → fact_page (many)
    //                fact_page (many) ↔ bridge_page_measure / bridge_page_datasource
    toIndex(workspaces) {
        const dim_workspace      = [];
        const dim_report         = [];
        const fact_page          = [];
        const bridge_page_measure    = [];
        const bridge_page_datasource = [];

        let totalMeasures = 0;

        for (const ws of workspaces) {
            if (!ws.parsedModel) continue;

            const fullCtx    = this.toAIContext(ws.parsedModel, ws.visualData, ws.lineageEngine);
            const folderName = ws._folderKey
                ? ws._folderKey.replace(/\.SemanticModel$/i, '').trim()
                : null;
            const workspaceName = ws._wsFolder || null;
            const reportName    = ws._reportName || folderName || fullCtx.model.name;

            // Stable surrogate keys
            const workspaceKey = (workspaceName || reportName).replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const reportKey    = reportName.replace(/[^a-z0-9]/gi, '_').toLowerCase();

            totalMeasures += fullCtx.model.measureCount;

            // dim_workspace (deduplicated)
            if (!dim_workspace.find(w => w.workspaceKey === workspaceKey)) {
                dim_workspace.push({
                    workspaceKey,
                    workspaceName: workspaceName || reportName
                });
            }

            // dim_report
            const wsSrcTypes = [...new Set(
                (fullCtx.catalog || []).flatMap(t => (t.dataSources || []).map(s => s.type)).filter(Boolean)
            )];
            dim_report.push({
                reportKey,
                workspaceKey,
                reportName,
                detailFile:   `${reportKey}-ai-context.json`,
                tableCount:   fullCtx.model.tableCount,
                measureCount: fullCtx.model.measureCount,
                pageCount:    fullCtx.model.pageCount,
                dataSources:  wsSrcTypes.join(', ')
            });

            // fact_page + bridges
            for (const p of (fullCtx.pages || [])) {
                fact_page.push({
                    pageId:        p.id,
                    reportKey,
                    workspaceKey,
                    pageName:      p.name,
                    summary:       p.summary,
                    visualCount:   p.visualCount,
                    isDrillthrough: p.isDrillthrough
                });

                for (const m of (p.allMeasures || [])) {
                    bridge_page_measure.push({ pageId: p.id, measure: m });
                }

                const srcTypes = [...new Set((p.allDataSources || []).map(s => s.type).filter(Boolean))];
                for (const src of srcTypes) {
                    bridge_page_datasource.push({ pageId: p.id, dataSource: src });
                }
            }
        }

        return {
            exportType:  'index',
            generatedAt: new Date().toISOString(),
            _meta: {
                schema:  'star',
                fact:    'fact_page',
                dimensions: ['dim_workspace', 'dim_report'],
                bridges: ['bridge_page_measure', 'bridge_page_datasource'],
                relationships: [
                    'dim_workspace.workspaceKey → dim_report.workspaceKey (1:many)',
                    'dim_report.reportKey → fact_page.reportKey (1:many)',
                    'fact_page.pageId → bridge_page_measure.pageId (1:many)',
                    'fact_page.pageId → bridge_page_datasource.pageId (1:many)',
                    'fact_page.pageId → detail file pages[].id (1:1, join via dim_report.detailFile)'
                ],
                workspaceCount: dim_workspace.length,
                reportCount:    dim_report.length,
                pageCount:      fact_page.length,
                measureCount:   totalMeasures
            },
            dim_workspace,
            dim_report,
            fact_page,
            bridge_page_measure,
            bridge_page_datasource
        };
    },

    // ── Vector list export (level 3) ─────────────────────────────────────────
    // One document per page, fully self-contained.
    // Each entry has a `text` field ready for embedding (Pinecone, pgvector, etc.)
    // and structured metadata fields for filtering without re-embedding.
    toVectorList(workspaces) {
        const docs = [];

        for (const ws of workspaces) {
            if (!ws.parsedModel) continue;

            const fullCtx    = this.toAIContext(ws.parsedModel, ws.visualData, ws.lineageEngine);
            const folderName = ws._folderKey
                ? ws._folderKey.replace(/\.SemanticModel$/i, '').trim()
                : null;
            const workspaceName = ws._wsFolder  || null;
            const reportName    = ws._reportName || folderName || fullCtx.model.name;

            for (const p of (fullCtx.pages || [])) {
                const srcTypes = [...new Set((p.allDataSources || []).map(s => s.type).filter(Boolean))];
                const measures = p.allMeasures || [];
                const tables   = p.allTables   || [];

                // Build a single embeddable text string combining all context
                const textParts = [
                    workspaceName ? `Workspace: ${workspaceName}.` : null,
                    `Report: ${reportName}.`,
                    `Page: ${p.name}.`,
                    p.summary,
                    measures.length  ? `Measures used: ${measures.join(', ')}.`    : null,
                    tables.length    ? `Source tables: ${tables.join(', ')}.`      : null,
                    srcTypes.length  ? `Data sources: ${srcTypes.join(', ')}.`     : null,
                    p.isDrillthrough ? 'This page is a drillthrough detail page.'  : null
                ].filter(Boolean).join(' ');

                docs.push({
                    // Identity & routing metadata
                    id:            p.id,
                    workspace:     workspaceName || reportName,
                    report:        reportName,
                    detailFile:    `${reportName.replace(/[^a-z0-9]/gi, '_')}-ai-context.json`,
                    page:          p.name,
                    isDrillthrough: p.isDrillthrough,
                    visualCount:   p.visualCount,
                    // Filterable arrays (don't embed these — use for metadata filtering)
                    measures,
                    tables,
                    dataSources:   srcTypes,
                    // The embeddable text — feed this field to your embedding model
                    text:          textParts
                });
            }
        }

        return docs;
    },

    // ── Vector JSONL export ───────────────────────────────────────────────────
    // Standard format for batch embedding APIs (OpenAI Files API, Cohere, Voyage).
    // One self-contained JSON object per line — no outer array.
    toVectorJSONL(workspaces) {
        const docs = this.toVectorList(workspaces);
        return docs.map(d => JSON.stringify(d)).join('\n');
    },

    // ── Agent system prompt generator ─────────────────────────────────────────
    // Markdown string that an AI agent can use as its system prompt or knowledge base.
    toSystemPrompt(workspaces, indexData) {
        const meta   = indexData._meta || {};
        const date   = new Date().toISOString().slice(0, 10);
        const allSrc = [...new Set((indexData.bridge_page_datasource || []).map(b => b.dataSource))];

        // Key KPIs: measures appearing on 3+ distinct pages
        const measurePageCount = {};
        for (const b of (indexData.bridge_page_measure || [])) {
            measurePageCount[b.measure] = (measurePageCount[b.measure] || new Set()).add(b.pageId);
        }
        const keyKPIs = Object.entries(measurePageCount)
            .filter(([, pages]) => pages.size >= 3)
            .sort((a, b) => b[1].size - a[1].size)
            .map(([name, pages]) => `- **${name}** (used on ${pages.size} pages)`);

        const drillthroughCount = (indexData.fact_page || []).filter(p => p.isDrillthrough).length;

        // Per-workspace sections
        const wsSections = (indexData.dim_report || []).map(rep => {
            const ws = (indexData.dim_workspace || []).find(w => w.workspaceKey === rep.workspaceKey);
            const pages = (indexData.fact_page || [])
                .filter(p => p.reportKey === rep.reportKey)
                .slice(0, 5)
                .map(p => p.pageName);
            return `### ${ws?.workspaceName || rep.workspaceKey} — ${rep.reportName}
- Tables: ${rep.tableCount} | Measures: ${rep.measureCount} | Pages: ${rep.pageCount}
- Data sources: ${rep.dataSources}
- Key pages: ${pages.join(', ')}
- Detail file: \`${rep.detailFile}\``;
        }).join('\n\n');

        return `# Power BI Catalog — AI Agent System Prompt
Generated: ${date}

## What you know
You have access to a Power BI catalog with **${meta.workspaceCount || 1} workspace(s)**, **${meta.reportCount || 1} report(s)**, and **${meta.pageCount || 0} report pages** containing **${meta.measureCount || 0} measures**.
All data is sourced from: ${allSrc.join(', ') || 'unknown'}.

## Workspaces
${wsSections}

## How to use this catalog
1. Use \`vector_search(query)\` to find relevant report pages by semantic similarity against the embedded JSONL catalog.
2. Use \`get_detail("{workspaceKey}")\` to retrieve full DAX expressions, column mappings, relationships, and RLS roles for a specific workspace.
3. Drillthrough pages (${drillthroughCount} total) provide row-level detail — navigate to them when a user asks for specifics on individual records.
4. All page IDs in vector search results match \`pages[].id\` in the detail files — join on this field for full context.

## Key KPIs (used on 3+ pages)
${keyKPIs.length ? keyKPIs.join('\n') : '_No measures appear on 3+ pages._'}

## Data freshness
This catalog was generated on ${date}. Re-export after semantic model changes.
`;
    },

    download(data, modelName) {
        const filename = `${(modelName || 'model').replace(/[^a-z0-9]/gi, '_')}-ai-context.json`;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    downloadText(text, filename, mimeType = 'text/plain') {
        const blob = new Blob([text], { type: mimeType });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
};

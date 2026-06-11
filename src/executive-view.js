/**
 * ExecutiveView
 * Renders the Lederoversikt (executive overview) and AI Context sections.
 * Uses only data already in parsedModel, visualData, and lineageEngine — no re-parsing.
 */
const ExecutiveView = {

    // ─────────────────────────────────────────────────────────────────────────
    // Lederoversikt
    // ─────────────────────────────────────────────────────────────────────────

    renderLederoversikt(container, workspaces) {
        if (!workspaces || workspaces.length === 0) {
            container.innerHTML = '<p class="muted-text">Last inn et workspace for å se lederoversikten.</p>';
            return;
        }

        // Aggregate across all workspaces
        const allSources = [];
        const seenSrcKeys = new Set();
        const pageData = [];
        const topMeasures = [];
        const seenMKeys = new Set();

        for (const ws of workspaces) {
            const { parsedModel: model, visualData, lineageEngine } = ws;
            // Collect sources
            if (lineageEngine) {
                for (const s of lineageEngine.getAllDataSources()) {
                    const k = `${s.type}|${s.server || s.url}|${s.database}`;
                    if (!seenSrcKeys.has(k)) { seenSrcKeys.add(k); allSources.push(s); }
                }
                // Top measures
                for (const m of lineageEngine.getTopMeasuresByVisualCount(15)) {
                    const k = `${ws.name}|${m.table}|${m.name}`;
                    if (!seenMKeys.has(k)) { seenMKeys.add(k); topMeasures.push({ ...m, _ws: ws }); }
                }
            }
            // Pages
            for (const p of this._buildPageData(model, visualData, lineageEngine)) {
                pageData.push({ ...p, _workspaceName: ws.name });
            }
        }

        let html = '';

        // ── 1. Beslutningskart ───────────────────────────────────────────────
        html += `<div class="exec-section-header">
            <span class="material-symbols-outlined" style="color:var(--accent)">map</span>
            <h3>Beslutningskart</h3>
            <p class="section-subtitle">Hver rapportside representerer et beslutningsområde. Her ser du hvilke nøkkeltall og datakilder som ligger bak.</p>
        </div>`;

        if (pageData.length === 0) {
            html += '<p class="muted-text" style="padding:12px 0">Ingen rapport-sider funnet. Last inn et workspace med rapport.</p>';
        } else {
            html += '<div class="exec-decision-grid">';
            for (const page of pageData) {
                const measureList = page.measures.slice(0, 4).join(', ');
                const moreM = page.measures.length > 4 ? ` +${page.measures.length - 4} til` : '';
                const sourceIcons = page.sources.map(s => this._sourceIcon(s.type)).join(' ');
                const sourceNames = page.sources.map(s => s.type).filter((v, i, a) => a.indexOf(v) === i).join(', ') || '—';
                const drillBadge = page.isDrillthrough
                    ? '<span class="exec-badge exec-badge--drill">Drillthrough</span>' : '';

                html += `<div class="exec-decision-card">
                    <div class="exec-card-top">
                        <div class="exec-card-icon"><span class="material-symbols-outlined">${page.isDrillthrough ? 'zoom_in' : 'article'}</span></div>
                        <div class="exec-card-title">${this._esc(page.name)} ${drillBadge}</div>
                    </div>
                    ${page._workspaceName ? `<div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">${this._esc(page._workspaceName)}</div>` : ''}
                    <div class="exec-card-meta">
                        <span class="exec-meta-chip"><span class="material-symbols-outlined" style="font-size:13px">visibility</span>${page.visualCount} visuals</span>
                        <span class="exec-meta-chip"><span class="material-symbols-outlined" style="font-size:13px">functions</span>${page.measures.length} measures</span>
                    </div>
                    ${measureList ? `<div class="exec-card-measures">${this._esc(measureList)}${this._esc(moreM)}</div>` : ''}
                    <div class="exec-card-sources">
                        <span style="font-size:11px;color:var(--text-light)">Datakilder:</span>
                        <span style="font-size:11px;margin-left:4px">${sourceIcons} ${this._esc(sourceNames)}</span>
                    </div>
                    ${page.filterConfig ? '<div class="exec-card-filter"><span class="material-symbols-outlined" style="font-size:12px">filter_alt</span> Har sidefilter</div>' : ''}
                </div>`;
            }
            html += '</div>';
        }

        // ── 2. Datakilder ────────────────────────────────────────────────────
        html += `<div class="exec-section-header" style="margin-top:32px">
            <span class="material-symbols-outlined" style="color:#27ae60">storage</span>
            <h3>Datakilder</h3>
            <p class="section-subtitle">Systemene som mater den semantiske modellen.</p>
        </div>`;

        if (allSources.length === 0) {
            html += '<p class="muted-text" style="padding:12px 0">Ingen datakilder funnet.</p>';
        } else {
            html += '<div class="exec-source-grid">';
            for (const src of allSources) {
                const server = src.serverResolved || src.server || src.url || src.path || '—';
                const db = src.databaseResolved || src.database || '—';
                let consumers = { tables: [], measures: [] };
                if (lineageEngine) {
                    try {
                        const srcKey = this._sourceLookupId(src, lineageEngine);
                        if (srcKey) consumers = lineageEngine.getDataSourceConsumers(srcKey);
                    } catch (_) {}
                }
                const tableNames = (consumers.tables || []).map(t => t.name).join(', ') || '—';

                html += `<div class="exec-source-card">
                    <div class="exec-source-header">
                        <span class="exec-source-icon">${this._sourceIcon(src.type)}</span>
                        <span class="exec-source-type">${this._esc(src.type || 'Unknown')}</span>
                        ${src.parameterized ? '<span class="exec-badge exec-badge--param">Parameterisert</span>' : ''}
                    </div>
                    <div class="exec-source-detail">${this._esc(server)}</div>
                    ${db !== '—' ? `<div class="exec-source-detail" style="color:var(--text-light)">${this._esc(db)}</div>` : ''}
                    <div class="exec-source-tables">
                        <span class="material-symbols-outlined" style="font-size:12px;vertical-align:middle">table_chart</span>
                        <span style="font-size:11px">${this._esc(tableNames)}</span>
                    </div>
                </div>`;
            }
            html += '</div>';
        }

        // ── 3. KPI-flyt ──────────────────────────────────────────────────────
        html += `<div class="exec-section-header" style="margin-top:32px">
            <span class="material-symbols-outlined" style="color:#e67e22">account_tree</span>
            <h3>KPI-flyt</h3>
            <p class="section-subtitle">Topp ${Math.min(topMeasures.length, 12)} measures etter visual-bruk — fra datakilde til rapportside.</p>
        </div>
        <div id="kpiFlowContainer" style="overflow:auto;background:var(--surface);border:1px solid var(--border-light);border-radius:8px;padding:8px"></div>`;

        container.innerHTML = html;

        // Render SVG after DOM update
        requestAnimationFrame(() => {
            this._renderKPIFlow(
                document.getElementById('kpiFlowContainer'),
                topMeasures.slice(0, 12)
            );
        });
    },

    // ─────────────────────────────────────────────────────────────────────────
    // AI Agent Export — complete pipeline export for RAG/embedding at scale
    // ─────────────────────────────────────────────────────────────────────────

    renderAIContext(container, workspaces) {
        if (!workspaces || workspaces.length === 0) {
            container.innerHTML = '<p class="muted-text">Load a workspace first.</p>';
            return;
        }

        container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-light)">Building export…</div>';

        setTimeout(() => {
            const indexData = LineageExporter.toIndex(workspaces);
            const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

            // ── Readiness metrics ──────────────────────────────────────────────
            let totalMeasures = 0, measuresWithDesc = 0;
            let totalTables   = 0, tablesWithDesc   = 0;
            let totalRoles    = 0, drillthroughCt   = 0;

            for (const ws of workspaces) {
                if (!ws.parsedModel) continue;
                for (const t of (ws.parsedModel.tables || [])) {
                    if (t._isAutoDate) continue;
                    totalTables++;
                    if (t.description) tablesWithDesc++;
                    for (const m of (t.measures || [])) {
                        totalMeasures++;
                        if (m.description) measuresWithDesc++;
                    }
                }
                totalRoles += (ws.parsedModel.roles || []).length;
            }
            drillthroughCt = (indexData.fact_page || []).filter(p => p.isDrillthrough).length;

            const mPct  = totalMeasures ? Math.round(measuresWithDesc / totalMeasures * 100) : 0;
            const tPct  = totalTables   ? Math.round(tablesWithDesc   / totalTables   * 100) : 0;
            const score = Math.round((mPct + tPct) / 2);
            const scoreColor = score >= 60 ? '#2e7d32' : score >= 30 ? '#e67e22' : '#c62828';

            const bar = (pct, color) =>
                `<div class="air-bar-track"><div class="air-bar-fill" style="width:${pct}%;background:${color}"></div></div>`;

            // ── Source types ───────────────────────────────────────────────────
            const allSrc = [...new Set((indexData.bridge_page_datasource||[]).map(b => b.dataSource))];

            // ── Size estimates ─────────────────────────────────────────────────
            const indexKB  = Math.round(JSON.stringify(indexData).length / 1024);
            const jsonlStr = LineageExporter.toVectorJSONL(workspaces);
            const jsonlKB  = Math.round(jsonlStr.length / 1024);
            const promptStr = LineageExporter.toSystemPrompt(workspaces, indexData);
            const promptKB  = Math.round(promptStr.length / 1024);

            // ── Per-workspace detail rows ──────────────────────────────────────
            const wsRows = workspaces.map((ws, i) => {
                const entry = indexData.dim_report[i] || {};
                const displayName = entry.reportName || ws._reportName || ws._wsFolder || ws.name;
                const srcBadges = (entry.dataSources||'').split(', ').filter(Boolean)
                    .map(s => `<span class="aic-src-badge">${esc(s)}</span>`).join('');
                return `<div class="aic-ws-row">
                    <div class="aic-ws-info">
                        <div class="aic-ws-name">${esc(displayName)}</div>
                        <div class="aic-ws-meta">${entry.tableCount??'?'} tables &middot; ${entry.measureCount??'?'} measures &middot; ${entry.pageCount??'?'} pages ${srcBadges ? '&nbsp;' + srcBadges : ''}</div>
                    </div>
                    <button class="aic-dl-btn aic-ws-dl" data-ws-idx="${i}">
                        <span class="material-symbols-outlined" style="font-size:15px">download</span> Download
                    </button>
                </div>`;
            }).join('');

            // ── Render ─────────────────────────────────────────────────────────
            container.innerHTML = `

            <!-- Readiness panel -->
            <div class="air-panel">
                <div class="air-score-wrap">
                    <div class="air-score-ring" style="--score-color:${scoreColor}">
                        <span class="air-score-num">${score}</span>
                        <span class="air-score-label">/ 100</span>
                    </div>
                    <div class="air-score-text">
                        <div class="air-score-title">Catalog Readiness</div>
                        <div class="air-score-sub">Based on measure &amp; table descriptions</div>
                    </div>
                </div>
                <div class="air-metrics">
                    <div class="air-metric">
                        <div class="air-metric-label">Measures with description</div>
                        ${bar(mPct, '#2e7d32')}
                        <div class="air-metric-count">${measuresWithDesc} / ${totalMeasures} (${mPct}%)</div>
                    </div>
                    <div class="air-metric">
                        <div class="air-metric-label">Tables with description</div>
                        ${bar(tPct, '#0077b6')}
                        <div class="air-metric-count">${tablesWithDesc} / ${totalTables} (${tPct}%)</div>
                    </div>
                    <div class="air-chips">
                        <span class="air-chip"><span class="material-symbols-outlined">shield</span>${totalRoles} RLS role${totalRoles !== 1 ? 's' : ''}</span>
                        <span class="air-chip"><span class="material-symbols-outlined">open_in_new</span>${drillthroughCt} drillthrough page${drillthroughCt !== 1 ? 's' : ''}</span>
                        ${allSrc.map(s => `<span class="air-chip"><span class="material-symbols-outlined">storage</span>${esc(s)}</span>`).join('')}
                    </div>
                </div>
            </div>

            <!-- Export cards -->
            <div class="aie-grid">

                <div class="aie-card">
                    <div class="aie-card-head">
                        <div class="aie-badge" style="background:#1a3a5c">1</div>
                        <div>
                            <div class="aie-title">Star Schema Index</div>
                            <div class="aie-format">JSON · ${indexKB} KB</div>
                        </div>
                    </div>
                    <div class="aie-desc">Structured Power BI–importable star schema: <code>dim_workspace</code>, <code>dim_report</code>, <code>fact_page</code>, bridge tables. Use for filtered queries and PBI semantic model integration.</div>
                    <button class="aie-btn" id="aicDlIndex">
                        <span class="material-symbols-outlined">download</span> Download index.json
                    </button>
                </div>

                <div class="aie-card">
                    <div class="aie-card-head">
                        <div class="aie-badge" style="background:#2e7d32">2</div>
                        <div>
                            <div class="aie-title">Workspace Detail</div>
                            <div class="aie-format">JSON · one file per workspace</div>
                        </div>
                    </div>
                    <div class="aie-desc">Full DAX expressions, column mappings, relationships, RLS roles, and visual-level lineage. Fetch only the workspace the agent needs to answer a specific question.</div>
                    <div class="aic-ws-list" style="margin-top:8px">${wsRows}</div>
                </div>

                <div class="aie-card">
                    <div class="aie-card-head">
                        <div class="aie-badge" style="background:#6a1b9a">3</div>
                        <div>
                            <div class="aie-title">Vector JSONL</div>
                            <div class="aie-format">JSONL · ${jsonlKB} KB · ${(indexData.fact_page||[]).length} documents</div>
                        </div>
                    </div>
                    <div class="aie-desc">One self-contained JSON object per line — the standard batch embedding format. Each document has a <code>text</code> field ready to embed and metadata fields for vector DB filtering.</div>
                    <button class="aie-btn aie-btn-primary" id="aicDlJSONL">
                        <span class="material-symbols-outlined">download</span> Download catalog.jsonl
                    </button>
                </div>

                <div class="aie-card">
                    <div class="aie-card-head">
                        <div class="aie-badge" style="background:#e67e22">4</div>
                        <div>
                            <div class="aie-title">Agent System Prompt</div>
                            <div class="aie-format">Markdown · ${promptKB} KB</div>
                        </div>
                    </div>
                    <div class="aie-desc">Ready-to-paste Markdown describing the catalog structure, workspaces, key KPIs, and tool usage instructions. Paste directly into your AI agent's system prompt.</div>
                    <button class="aie-btn" id="aicDlPrompt">
                        <span class="material-symbols-outlined">download</span> Download system-prompt.md
                    </button>
                </div>

            </div>

            <!-- Integration guide -->
            <details class="aie-guide">
                <summary class="aie-guide-summary">
                    <span class="material-symbols-outlined">help_outline</span>
                    How to wire this into an AI agent
                </summary>
                <div class="aie-guide-steps">
                    <div class="aie-step">
                        <div class="aie-step-num">1</div>
                        <div><strong>Embed</strong> — Upload <code>catalog.jsonl</code> to your embedding pipeline (OpenAI batch files API, Cohere, Voyage AI). Each line's <code>text</code> field becomes a vector. Store with all metadata fields for filtering.</div>
                    </div>
                    <div class="aie-step">
                        <div class="aie-step-num">2</div>
                        <div><strong>Store</strong> — Upsert to Pinecone, pgvector, or Weaviate. Index on metadata: <code>workspace</code>, <code>report</code>, <code>dataSources[]</code>, <code>isDrillthrough</code>. Use <code>id</code> as the primary key.</div>
                    </div>
                    <div class="aie-step">
                        <div class="aie-step-num">3</div>
                        <div><strong>Query</strong> — Agent gets a question → vector search with optional metadata filter → top K pages → look up <code>detailFile</code> from the index → fetch the workspace detail JSON → answer with full DAX context.</div>
                    </div>
                </div>
            </details>

            <!-- ── Star Schema diagram ──────────────────────────────────────── -->
            <div class="aie-diagram-section">
                <div class="aie-section-label">
                    <span class="material-symbols-outlined">table_chart</span>
                    Stjerneskjema — ${(indexData.fact_page||[]).length} sider · ${(indexData.dim_workspace||[]).length} workspace(s) · ${(indexData.bridge_page_measure||[]).length} measure-koblinger
                </div>
                <div class="aie-schema-wrap">
                    <svg viewBox="0 0 730 375" xmlns="http://www.w3.org/2000/svg" class="aie-schema-svg">
                        <defs>
                            <marker id="aie-arr-blue" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#0077b6"/></marker>
                            <marker id="aie-arr-purple" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#6a1b9a"/></marker>
                            <marker id="aie-arr-dim" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#888"/></marker>
                        </defs>

                        <!-- dim_workspace → dim_report (snowflake hierarchy) -->
                        <line x1="222" y1="65" x2="498" y2="65" stroke="#888" stroke-width="1" stroke-dasharray="5,3" marker-end="url(#aie-arr-dim)"/>
                        <text x="360" y="58" text-anchor="middle" font-size="9" fill="#888">1 : many</text>

                        <!-- dim_workspace → fact_page -->
                        <line x1="120" y1="102" x2="302" y2="152" stroke="#0077b6" stroke-width="1.5" marker-end="url(#aie-arr-blue)"/>
                        <!-- dim_report → fact_page -->
                        <line x1="600" y1="102" x2="428" y2="152" stroke="#0077b6" stroke-width="1.5" marker-end="url(#aie-arr-blue)"/>
                        <!-- fact_page → bridge_page_measure -->
                        <line x1="298" y1="242" x2="165" y2="273" stroke="#6a1b9a" stroke-width="1.5" marker-end="url(#aie-arr-purple)"/>
                        <!-- fact_page → bridge_page_datasource -->
                        <line x1="432" y1="242" x2="567" y2="273" stroke="#6a1b9a" stroke-width="1.5" marker-end="url(#aie-arr-purple)"/>

                        <!-- dim_workspace -->
                        <rect x="20" y="30" width="200" height="72" rx="8" fill="var(--card-bg,#1a2744)" stroke="#0077b6" stroke-width="1.5"/>
                        <text x="120" y="52" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text,#e2e8f0)">dim_workspace</text>
                        <text x="120" y="68" text-anchor="middle" font-size="10" fill="var(--text-secondary,#94a3b8)">workspaceKey · workspaceName</text>
                        <text x="120" y="84" text-anchor="middle" font-size="10" font-weight="600" fill="#0077b6">${(indexData.dim_workspace||[]).length} rad(er)</text>

                        <!-- dim_report -->
                        <rect x="510" y="30" width="200" height="72" rx="8" fill="var(--card-bg,#1a2744)" stroke="#0077b6" stroke-width="1.5"/>
                        <text x="610" y="52" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text,#e2e8f0)">dim_report</text>
                        <text x="610" y="68" text-anchor="middle" font-size="10" fill="var(--text-secondary,#94a3b8)">reportKey · reportName · detailFile</text>
                        <text x="610" y="84" text-anchor="middle" font-size="10" font-weight="600" fill="#0077b6">${(indexData.dim_report||[]).length} rad(er)</text>

                        <!-- fact_page (center, highlighted) -->
                        <rect x="248" y="152" width="234" height="90" rx="8" fill="#0077b610" stroke="#0077b6" stroke-width="2.5"/>
                        <text x="365" y="174" text-anchor="middle" font-size="13" font-weight="700" fill="#0077b6">fact_page</text>
                        <text x="365" y="190" text-anchor="middle" font-size="10" fill="var(--text-secondary,#94a3b8)">pageId · pageName · summary</text>
                        <text x="365" y="205" text-anchor="middle" font-size="10" fill="var(--text-secondary,#94a3b8)">workspaceKey · reportKey · visualCount</text>
                        <text x="365" y="222" text-anchor="middle" font-size="11" font-weight="700" fill="#0077b6">${(indexData.fact_page||[]).length} rad(er)</text>

                        <!-- bridge_page_measure -->
                        <rect x="20" y="273" width="200" height="62" rx="8" fill="var(--card-bg,#1a2744)" stroke="#6a1b9a" stroke-width="1.5"/>
                        <text x="120" y="294" text-anchor="middle" font-size="11" font-weight="700" fill="var(--text,#e2e8f0)">bridge_page_measure</text>
                        <text x="120" y="310" text-anchor="middle" font-size="10" fill="var(--text-secondary,#94a3b8)">pageId · measure</text>
                        <text x="120" y="326" text-anchor="middle" font-size="10" font-weight="600" fill="#6a1b9a">${(indexData.bridge_page_measure||[]).length} rad(er)</text>

                        <!-- bridge_page_datasource -->
                        <rect x="500" y="273" width="220" height="62" rx="8" fill="var(--card-bg,#1a2744)" stroke="#6a1b9a" stroke-width="1.5"/>
                        <text x="610" y="294" text-anchor="middle" font-size="11" font-weight="700" fill="var(--text,#e2e8f0)">bridge_page_datasource</text>
                        <text x="610" y="310" text-anchor="middle" font-size="10" fill="var(--text-secondary,#94a3b8)">pageId · dataSource</text>
                        <text x="610" y="326" text-anchor="middle" font-size="10" font-weight="600" fill="#6a1b9a">${(indexData.bridge_page_datasource||[]).length} rad(er)</text>

                        <!-- Legend -->
                        <line x1="20" y1="356" x2="50" y2="356" stroke="#0077b6" stroke-width="1.5" marker-end="url(#aie-arr-blue)"/>
                        <text x="55" y="360" font-size="10" fill="var(--text-secondary,#94a3b8)">Dimensjon → Fakta</text>
                        <line x1="210" y1="356" x2="240" y2="356" stroke="#6a1b9a" stroke-width="1.5" marker-end="url(#aie-arr-purple)"/>
                        <text x="245" y="360" font-size="10" fill="var(--text-secondary,#94a3b8)">Fakta → Bro</text>
                        <line x1="370" y1="356" x2="400" y2="356" stroke="#888" stroke-width="1" stroke-dasharray="5,3" marker-end="url(#aie-arr-dim)"/>
                        <text x="405" y="360" font-size="10" fill="var(--text-secondary,#94a3b8)">Snøflak-hierarki</text>
                    </svg>
                </div>
            </div>

            <!-- ── Agent query flow ──────────────────────────────────────────── -->
            <div class="aie-diagram-section" style="margin-top:16px">
                <div class="aie-section-label">
                    <span class="material-symbols-outlined">alt_route</span>
                    Agent query-flyt
                </div>
                <div class="aie-flow-wrap">
                    <div class="aie-flow-step">
                        <div class="aie-flow-icon" style="background:#1a3a5c">
                            <span class="material-symbols-outlined">person</span>
                        </div>
                        <div class="aie-flow-label">Bruker-<br>spørsmål</div>
                    </div>
                    <div class="aie-flow-arrow">›</div>
                    <div class="aie-flow-step">
                        <div class="aie-flow-icon" style="background:#6a1b9a">
                            <span class="material-symbols-outlined">travel_explore</span>
                        </div>
                        <div class="aie-flow-label">Vector<br>search</div>
                        <div class="aie-flow-sub">catalog.jsonl<br>Pinecone/pgvector</div>
                    </div>
                    <div class="aie-flow-arrow">›</div>
                    <div class="aie-flow-step">
                        <div class="aie-flow-icon" style="background:#0e6896">
                            <span class="material-symbols-outlined">filter_list</span>
                        </div>
                        <div class="aie-flow-label">Topp K<br>sider</div>
                        <div class="aie-flow-sub">fra fact_page<br>+ metadata-filter</div>
                    </div>
                    <div class="aie-flow-arrow">›</div>
                    <div class="aie-flow-step">
                        <div class="aie-flow-icon" style="background:#1a4a2a">
                            <span class="material-symbols-outlined">find_in_page</span>
                        </div>
                        <div class="aie-flow-label">Slå opp<br>detailFile</div>
                        <div class="aie-flow-sub">dim_report<br>→ index.json</div>
                    </div>
                    <div class="aie-flow-arrow">›</div>
                    <div class="aie-flow-step">
                        <div class="aie-flow-icon" style="background:#7a3a00">
                            <span class="material-symbols-outlined">cloud_download</span>
                        </div>
                        <div class="aie-flow-label">Hent<br>detail JSON</div>
                        <div class="aie-flow-sub">DAX · relasjoner<br>RLS · kolonner</div>
                    </div>
                    <div class="aie-flow-arrow">›</div>
                    <div class="aie-flow-step">
                        <div class="aie-flow-icon" style="background:#6a1b1b">
                            <span class="material-symbols-outlined">smart_toy</span>
                        </div>
                        <div class="aie-flow-label">AI-agent<br>svarer</div>
                        <div class="aie-flow-sub">system prompt<br>+ full kontekst</div>
                    </div>
                </div>
            </div>`;

            // ── Event listeners ────────────────────────────────────────────────
            document.getElementById('aicDlIndex').addEventListener('click', () => {
                LineageExporter.download(indexData, 'all-workspaces-index');
            });

            document.getElementById('aicDlJSONL').addEventListener('click', () => {
                const btn = document.getElementById('aicDlJSONL');
                const orig = btn.innerHTML;
                btn.disabled = true;
                btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:15px">hourglass_top</span> Building…';
                setTimeout(() => {
                    try { LineageExporter.downloadText(jsonlStr, 'catalog.jsonl', 'application/jsonl'); }
                    finally { btn.disabled = false; btn.innerHTML = orig; }
                }, 30);
            });

            document.getElementById('aicDlPrompt').addEventListener('click', () => {
                LineageExporter.downloadText(promptStr, 'system-prompt.md', 'text/markdown');
            });

            container.querySelectorAll('.aic-ws-dl').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.wsIdx, 10);
                    const ws  = workspaces[idx];
                    if (!ws) return;
                    const orig = btn.innerHTML;
                    btn.disabled = true;
                    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:15px">hourglass_top</span>';
                    setTimeout(() => {
                        try {
                            const data = LineageExporter.toAIContext(ws.parsedModel, ws.visualData, ws.lineageEngine);
                            LineageExporter.download(data, data.model?.name || ws.name);
                        } finally { btn.disabled = false; btn.innerHTML = orig; }
                    }, 30);
                });
            });
        }, 30);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // KPI Flow SVG
    // ─────────────────────────────────────────────────────────────────────────

    _renderKPIFlow(container, topMeasures) {
        if (!container) return;
        if (topMeasures.length === 0) {
            container.innerHTML = '<p class="muted-text" style="padding:16px">Ingen measures med visual-bruk funnet.</p>';
            return;
        }

        // Collect nodes per column: sources | tables | measures | pages
        const sourceMap = new Map();  // key → { label, type }
        const tableMap = new Map();   // tableName → {}
        const measureList = [];       // { name, table }
        const pageMap = new Map();    // pageName → {}

        // Edges: { from: colIndex+key, to: colIndex+key }
        const edges = [];

        for (const m of topMeasures) {
            const lineageEngine = m._ws?.lineageEngine;
            const fieldUsageMap = m._ws?.visualData?.fieldUsageMap || {};
            const measureKey = `${m.table}|${m.name}`;
            if (!measureList.find(x => x.key === measureKey)) {
                measureList.push({ key: measureKey, name: m.name, table: m.table });
            }

            // Table
            tableMap.set(m.table, {});
            edges.push({ from: `t:${m.table}`, to: `m:${measureKey}` });

            // Pages via fieldUsageMap
            const usages = fieldUsageMap[`measure|${m.table}|${m.name}`] || [];
            for (const u of usages) {
                if (u.pageName) {
                    pageMap.set(u.pageName, {});
                    edges.push({ from: `m:${measureKey}`, to: `p:${u.pageName}` });
                }
            }

            // Sources via lineage engine
            if (lineageEngine) {
                try {
                    const fl = lineageEngine.getFieldLineage('measure', m.table, m.name);
                    for (const src of (fl.dataSources || [])) {
                        const sKey = [src.type, src.serverResolved || src.server, src.databaseResolved || src.database].filter(Boolean).join('|');
                        if (!sourceMap.has(sKey)) {
                            sourceMap.set(sKey, { label: src.type || 'Source', type: src.type });
                        }
                        edges.push({ from: `s:${sKey}`, to: `t:${m.table}` });
                    }
                } catch (_) {}
            }
        }

        const sources = [...sourceMap.entries()].map(([k, v]) => ({ key: k, ...v }));
        const tableList = [...tableMap.keys()].map(k => ({ key: k, name: k }));
        const pageList = [...pageMap.keys()].map(k => ({ key: k, name: k }));

        // Layout
        const colW = 180, nodeH = 32, nodeVGap = 10, padX = 24, padY = 20;
        const cols = [sources, tableList, measureList, pageList];
        const colCount = cols.length;
        const maxNodes = Math.max(...cols.map(c => c.length), 1);
        const svgH = padY * 2 + maxNodes * (nodeH + nodeVGap);
        const svgW = padX * 2 + colCount * colW + (colCount - 1) * 40;

        const colColors = ['#27ae60', '#3498db', '#e67e22', '#1abc9c'];
        const colLabels = ['Datakilder', 'Tabeller', 'Measures', 'Sider'];

        // Compute node positions
        const nodePos = new Map();
        cols.forEach((col, ci) => {
            const x = padX + ci * (colW + 40) + colW / 2;
            const totalH = col.length * (nodeH + nodeVGap) - nodeVGap;
            const startY = padY + 28 + (maxNodes * (nodeH + nodeVGap) - nodeVGap - totalH) / 2;
            col.forEach((node, ni) => {
                const nKey = ci === 0 ? `s:${node.key}` : ci === 1 ? `t:${node.key}` : ci === 2 ? `m:${node.key}` : `p:${node.key}`;
                nodePos.set(nKey, { x, y: startY + ni * (nodeH + nodeVGap), ci });
            });
        });

        // Deduplicate edges
        const edgeSet = new Set();
        const dedupedEdges = [];
        for (const e of edges) {
            const k = `${e.from}→${e.to}`;
            if (!edgeSet.has(k) && nodePos.has(e.from) && nodePos.has(e.to)) {
                edgeSet.add(k);
                dedupedEdges.push(e);
            }
        }

        // Build SVG
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" style="min-width:${svgW}px">`;

        // Column header labels
        cols.forEach((col, ci) => {
            const x = padX + ci * (colW + 40) + colW / 2;
            svg += `<text x="${x}" y="${padY + 14}" text-anchor="middle" font-size="10" font-family="Segoe UI,sans-serif" font-weight="600" fill="${colColors[ci]}" text-transform="uppercase" letter-spacing="1">${colLabels[ci].toUpperCase()}</text>`;
            svg += `<line x1="${padX + ci * (colW + 40)}" y1="${padY + 20}" x2="${padX + ci * (colW + 40) + colW}" y2="${padY + 20}" stroke="${colColors[ci]}" stroke-width="2" opacity="0.4"/>`;
        });

        // Edges (draw behind nodes)
        for (const e of dedupedEdges) {
            const from = nodePos.get(e.from);
            const to = nodePos.get(e.to);
            if (!from || !to) continue;
            const x1 = from.x + colW / 2;
            const y1 = from.y + nodeH / 2;
            const x2 = to.x - colW / 2;
            const y2 = to.y + nodeH / 2;
            const mx = (x1 + x2) / 2;
            svg += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="rgba(126,200,227,0.2)" stroke-width="1.5"/>`;
        }

        // Nodes
        cols.forEach((col, ci) => {
            const color = colColors[ci];
            col.forEach(node => {
                const nKey = ci === 0 ? `s:${node.key}` : ci === 1 ? `t:${node.key}` : ci === 2 ? `m:${node.key}` : `p:${node.key}`;
                const pos = nodePos.get(nKey);
                if (!pos) return;
                const nx = pos.x - colW / 2;
                const ny = pos.y;
                const label = node.label || node.name || node.key;
                const truncated = label.length > 22 ? label.slice(0, 20) + '…' : label;

                svg += `<rect x="${nx}" y="${ny}" width="${colW}" height="${nodeH}" rx="5" fill="${color}22" stroke="${color}" stroke-width="1" opacity="0.9"/>`;
                svg += `<text x="${nx + colW / 2}" y="${ny + nodeH / 2 + 4}" text-anchor="middle" font-size="11" font-family="Segoe UI,sans-serif" fill="${color}">
                    <title>${this._escXML(label)}</title>${this._escXML(truncated)}</text>`;
            });
        });

        svg += '</svg>';
        container.innerHTML = svg;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    _buildPageData(model, visualData, lineageEngine) {
        if (!visualData || !visualData.pages) return [];
        const fieldUsageMap = visualData.fieldUsageMap || {};
        const measureSet = new Set();
        for (const table of model.tables) {
            for (const m of table.measures) {
                measureSet.add(`${table.name}|${m.name}`);
            }
        }

        return visualData.pages.map(page => {
            const measuresOnPage = new Set();
            const sourcesOnPage = [];

            for (const visual of (page.visuals || [])) {
                for (const field of (visual.fields || [])) {
                    const tableName = field.table || '';
                    const fieldName = field.name || field.column || '';
                    if (measureSet.has(`${tableName}|${fieldName}`)) {
                        measuresOnPage.add(fieldName);
                    }
                    // Trace sources
                    if (lineageEngine && tableName) {
                        try {
                            const isMeasure = measureSet.has(`${tableName}|${fieldName}`);
                            const fl = lineageEngine.getFieldLineage(isMeasure ? 'measure' : 'column', tableName, fieldName);
                            for (const s of (fl.dataSources || [])) {
                                const key = `${s.type}|${s.database}|${s.physicalTable}`;
                                if (!sourcesOnPage.some(x => `${x.type}|${x.database}|${x.physicalTable}` === key)) {
                                    sourcesOnPage.push(s);
                                }
                            }
                        } catch (_) {}
                    }
                }
            }

            return {
                id: page.id,
                name: page.displayName || page.name,
                isDrillthrough: page.isDrillthrough || false,
                visualCount: (page.visuals || []).length,
                measures: [...measuresOnPage],
                sources: sourcesOnPage,
                filterConfig: page.filterConfig || null
            };
        });
    },

    _sourceLookupId(src, lineageEngine) {
        const server = src.serverResolved || src.server || src.url || src.path || '';
        const db = src.databaseResolved || src.database || '';
        const type = src.type || '';
        for (const [id, node] of lineageEngine.nodes) {
            if (node.type === 'dataSource') {
                const ns = node.serverResolved || node.server || node.url || node.path || '';
                const nd = node.databaseResolved || node.database || '';
                if (node.sourceType === type && ns === server && nd === db) return id;
            }
        }
        return null;
    },

    _sourceIcon(type) {
        const icons = {
            'SQL Server': '🗄️', 'Snowflake': '❄️', 'BigQuery': '🔷',
            'Excel': '📗', 'Web': '🌐', 'OData': '🔗', 'Oracle': '🔴',
            'Dataverse': '🟦', 'SharePoint': '📁', 'CSV': '📄'
        };
        return icons[type] || '💾';
    },

    _esc(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    _escXML(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
};

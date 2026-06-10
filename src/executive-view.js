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
    // AI Context — two-level export
    // ─────────────────────────────────────────────────────────────────────────

    renderAIContext(container, workspaces) {
        if (!workspaces || workspaces.length === 0) {
            container.innerHTML = '<p class="muted-text">Load a workspace first.</p>';
            return;
        }

        container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-light)">Building index…</div>';

        // Defer so the loading text renders before the heavy build
        setTimeout(() => {
            const indexData = LineageExporter.toIndex(workspaces);
            const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

            // Stats row
            const allSrcTypes = [...new Set((indexData.bridge_page_datasource||[]).map(b => b.dataSource))];
            const srcChips = allSrcTypes.map(s =>
                `<div class="aic-stat-chip aic-src-chip"><span class="material-symbols-outlined">database</span>${esc(s)}</div>`).join('');

            // Build lookup maps from star schema tables
            const reportByKey = Object.fromEntries((indexData.dim_report||[]).map(r => [r.reportKey, r]));
            const wsMap       = Object.fromEntries((indexData.dim_workspace||[]).map(w => [w.workspaceKey, w.workspaceName]));
            const srcByPageId = {};
            for (const b of (indexData.bridge_page_datasource||[])) {
                if (!srcByPageId[b.pageId]) srcByPageId[b.pageId] = [];
                srcByPageId[b.pageId].push(b.dataSource);
            }

            const previewPages = (indexData.fact_page||[]).filter(p => !p.isDrillthrough).slice(0, 12);
            const previewRows = previewPages.map(p => {
                const rep = reportByKey[p.reportKey] || {};
                const wsName  = wsMap[p.workspaceKey] || p.workspaceKey || '—';
                const repName = rep.reportName || p.reportKey || '—';
                const srcs    = (srcByPageId[p.pageId] || []).join(', ') || '—';
                return `
                <tr>
                    <td style="font-weight:500;color:var(--accent)">${esc(wsName)}</td>
                    <td style="font-weight:500">${esc(repName)}</td>
                    <td>${esc(p.pageName)}</td>
                    <td style="color:var(--text-secondary);font-size:11px">${esc(srcs)}</td>
                </tr>`;
            }).join('');
            const totalPageCount = (indexData.fact_page||[]).length;
            const moreNote = totalPageCount > 12
                ? `<div class="aic-preview-more">+ ${totalPageCount - 12} more pages in the downloaded file</div>` : '';

            const estimateKB = Math.round(JSON.stringify(indexData).length / 1024);

            // Per-workspace rows
            const wsRows = workspaces.map((ws, i) => {
                const entry = indexData.dim_report[i] || {};
                const srcBadges = (entry.dataSources||'').split(', ').filter(Boolean).map(s=>
                    `<span class="aic-src-badge">${esc(s)}</span>`).join('');
                const displayName = entry.reportName || ws._reportName || ws._wsFolder || ws.name;
                return `
                <div class="aic-ws-row">
                    <div class="aic-ws-info">
                        <div class="aic-ws-name">${esc(displayName)}</div>
                        <div class="aic-ws-meta">
                            ${entry.tableCount??'?'} tables &middot;
                            ${entry.measureCount??'?'} measures &middot;
                            ${entry.pageCount??'?'} pages
                            ${srcBadges?`&nbsp;${srcBadges}`:''}
                        </div>
                    </div>
                    <button class="aic-dl-btn aic-ws-dl" data-ws-idx="${i}">
                        <span class="material-symbols-outlined" style="font-size:15px">download</span>
                        Download detail
                    </button>
                </div>`;
            }).join('');

            container.innerHTML = `
            <div class="aic-stats-row">
                <div class="aic-stat-chip"><span class="material-symbols-outlined">folder_open</span><strong>${indexData._meta.workspaceCount}</strong> workspaces</div>
                <div class="aic-stat-chip"><span class="material-symbols-outlined">description</span><strong>${indexData._meta.pageCount}</strong> pages</div>
                <div class="aic-stat-chip"><span class="material-symbols-outlined">functions</span><strong>${indexData._meta.measureCount}</strong> measures</div>
                ${srcChips}
            </div>

            <div class="aic-level-card">
                <div class="aic-level-head">
                    <div class="aic-level-badge">1</div>
                    <div class="aic-level-text">
                        <div class="aic-level-title">Index — all workspaces</div>
                        <div class="aic-level-desc">
                            Lightweight file (~${estimateKB} KB) with every page and its natural-language summary.
                            The AI agent searches here to find the right workspace and page, then fetches the detail file.
                        </div>
                    </div>
                    <button class="aic-dl-btn aic-dl-primary" id="aicDlIndex">
                        <span class="material-symbols-outlined" style="font-size:15px">download</span>
                        Download index.json
                    </button>
                </div>
                <div class="aic-preview-wrap">
                    <div class="aic-preview-label">Preview — first ${previewPages.length} pages</div>
                    <div style="overflow-x:auto">
                        <table class="aic-preview-table">
                            <thead><tr><th>Workspace</th><th>Report</th><th>Page</th><th>Data sources</th></tr></thead>
                            <tbody>${previewRows}</tbody>
                        </table>
                    </div>
                    ${moreNote}
                </div>
            </div>

            <div class="aic-level-card">
                <div class="aic-level-head">
                    <div class="aic-level-badge">2</div>
                    <div class="aic-level-text">
                        <div class="aic-level-title">Detail — per workspace</div>
                        <div class="aic-level-desc">
                            Full context with DAX expressions, column mappings, relationships and RLS roles.
                            Download only the workspace the AI agent needs to answer a specific question.
                        </div>
                    </div>
                </div>
                <div class="aic-ws-list">${wsRows}</div>
            </div>

            <div class="aic-level-card">
                <div class="aic-level-head">
                    <div class="aic-level-badge" style="background:var(--accent-success,#2dd4bf)">3</div>
                    <div class="aic-level-text">
                        <div class="aic-level-title">Vector list — flat page index</div>
                        <div class="aic-level-desc">
                            One JSON document per page with all context pre-merged and a ready-to-embed
                            <code>text</code> field. Drop directly into Pinecone, pgvector, or any RAG pipeline —
                            no joins required.
                        </div>
                    </div>
                </div>
                <div style="padding:0 16px 16px">
                    <button class="aic-dl-btn" id="aicDlVector">
                        <span class="material-symbols-outlined" style="font-size:15px">download</span>
                        Download vector list
                    </button>
                </div>
            </div>`;

            document.getElementById('aicDlIndex').addEventListener('click', () => {
                LineageExporter.download(indexData, 'all-workspaces-index');
            });

            container.querySelectorAll('.aic-ws-dl').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx  = parseInt(btn.dataset.wsIdx, 10);
                    const ws   = workspaces[idx];
                    if (!ws) return;
                    const orig = btn.innerHTML;
                    btn.disabled = true;
                    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:15px">hourglass_top</span> Building…';
                    setTimeout(() => {
                        try {
                            const data = LineageExporter.toAIContext(ws.parsedModel, ws.visualData, ws.lineageEngine);
                            LineageExporter.download(data, data.model?.name || ws.name);
                        } finally {
                            btn.disabled = false;
                            btn.innerHTML = orig;
                        }
                    }, 30);
                });
            });

            const vectorBtn = document.getElementById('aicDlVector');
            if (vectorBtn) {
                vectorBtn.addEventListener('click', () => {
                    const orig = vectorBtn.innerHTML;
                    vectorBtn.disabled = true;
                    vectorBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:15px">hourglass_top</span> Building…';
                    setTimeout(() => {
                        try {
                            const docs = LineageExporter.toVectorList(workspaces);
                            LineageExporter.download(docs, 'all-workspaces-vector-list');
                        } finally {
                            vectorBtn.disabled = false;
                            vectorBtn.innerHTML = orig;
                        }
                    }, 30);
                });
            }
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

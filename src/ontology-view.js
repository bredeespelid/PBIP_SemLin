/**
 * PBIP SemLin — Ontology View
 * Renders the semantic model as a navigable ontology graph.
 * Entity types (tables), properties (columns), KPIs (measures),
 * relationships, and data source bindings — all in one view.
 */

class OntologyRenderer {
    constructor(model, lineageEngine, visualData, bpaResults) {
        this.model = model;
        this.engine = lineageEngine;
        this.visualData = visualData;
        this.bpaResults = bpaResults;
        this._cleanupFn = null;
        this._selectedEntity = null;

        this.C = {
            entity:   '#1a3a5c',
            fp:       '#6a1b9a',
            cg:       '#5c3d1a',
            hidden:   '#4a4a4a',
            source:   '#1b5e20',
            bg:       '#ffffff',
            bgHidden: '#f7f7f7',
            border:   '#d0ccc4',
            accent:   '#86BC25',
            text:     '#2c2c2c',
            textSub:  '#666666',
            warn:     '#ffb81c',
            crit:     '#da291c',
        };

        this.NW = 230;   // node width
        this.NH = 136;   // node height
        this.SW = 170;   // source node width
        this.SH = 46;    // source node height
    }

    // ── Public entry point ────────────────────────────────────────────────────

    render(container) {
        if (this._cleanupFn) { this._cleanupFn(); this._cleanupFn = null; }

        const m = this.model;
        const visibleTables = m.tables.filter(t => !t._isAutoDate);

        // Build enriched entity list
        const entities = visibleTables.map(t => this._enrichTable(t));

        // Build layout
        const { positions, sourcePositions, canvasW, canvasH } =
            this._computeLayout(entities, m.relationships);

        // Clear container (keep toolbar)
        const existingSvg = container.querySelector('svg.ontology-svg');
        if (existingSvg) existingSvg.remove();
        const existingPanel = container.querySelector('.ontology-detail');
        if (existingPanel) existingPanel.remove();

        // Create SVG
        const padding = 60;
        const svgW = canvasW + padding * 2;
        const svgH = canvasH + padding * 2 + 80;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'ontology-svg');
        svg.setAttribute('width', svgW);
        svg.setAttribute('height', svgH);
        svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);

        // Arrow markers
        this._addMarkers(svg);

        // Offset group
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('transform', `translate(${padding}, ${padding + 40})`);
        svg.appendChild(g);

        // Draw data source nodes
        const sourceMap = new Map();
        sourcePositions.forEach((pos, sourceId) => {
            const srcNode = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            srcNode.setAttribute('class', 'ontology-source-node');
            this._drawSourceNode(srcNode, sourceId, pos);
            g.appendChild(srcNode);
            sourceMap.set(sourceId, pos);
        });

        // Draw source-to-entity connector lines (dashed, subtle)
        entities.forEach(ent => {
            if (!ent.sourceId) return;
            const srcPos = sourceMap.get(ent.sourceId);
            const entPos = positions.get(ent.name);
            if (!srcPos || !entPos) return;
            const line = this._el('line', {
                x1: srcPos.x + this.SW / 2, y1: srcPos.y,
                x2: entPos.x + this.NW / 2, y2: entPos.y + this.NH,
                stroke: '#c0ccc0', 'stroke-width': 1,
                'stroke-dasharray': '4 3', opacity: 0.5
            });
            g.appendChild(line);
        });

        // Draw relationship edges
        m.relationships.forEach(rel => {
            const fromPos = positions.get(rel.fromTable);
            const toPos   = positions.get(rel.toTable);
            if (!fromPos || !toPos) return;
            this._drawRelEdge(g, rel, fromPos, toPos);
        });

        // Draw entity nodes
        entities.forEach(ent => {
            const pos = positions.get(ent.name);
            if (!pos) return;
            const nodeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            nodeG.setAttribute('class', 'ontology-node');
            nodeG.setAttribute('data-entity', ent.name);
            nodeG.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
            this._drawEntityNode(nodeG, ent);
            g.appendChild(nodeG);
        });

        container.appendChild(svg);

        // Detail panel placeholder
        const panel = document.createElement('div');
        panel.className = 'ontology-detail hidden';
        panel.id = 'ontologyDetailPanel';
        container.appendChild(panel);

        // Wire up zoom/pan and click handlers
        this._initZoomPan(svg, container);
        this._initNodeClicks(svg, entities, container);
    }

    // ── Table enrichment ──────────────────────────────────────────────────────

    _enrichTable(t) {
        const bpaIssues = (this.bpaResults?.findings || [])
            .filter(f => f.table === t.name);
        const critCount = bpaIssues.filter(f => f.severity === 3).length;
        const warnCount = bpaIssues.filter(f => f.severity === 2).length;

        let visualCount = 0;
        if (this.visualData) {
            const usage = this.visualData.fieldUsageMap || {};
            Object.keys(usage).forEach(key => {
                if (key.startsWith(`column|${t.name}|`) || key.startsWith(`measure|${t.name}|`)) {
                    visualCount += (usage[key] || []).length;
                }
            });
        }

        // Find data source via lineage engine
        let sourceId = null;
        let sourceName = null;
        if (this.engine) {
            try {
                const srcs = this.engine.getAllDataSources();
                const tableNode = this.engine.nodes?.get(`table:${t.name}`);
                if (tableNode) {
                    const edge = (this.engine.edges || []).find(e =>
                        e.to === `table:${t.name}` && e.from.startsWith('source:')
                    );
                    if (edge) {
                        const src = srcs.find(s => `source:${s.id || s.name}` === edge.from ||
                            edge.from === `source:${s.sourceType}|${s.server || ''}|${s.database || ''}`);
                        if (src) { sourceId = edge.from; sourceName = src.sourceType || src.name; }
                    }
                }
            } catch {}
        }

        const visibleCols = t.columns.filter(c => !c.isHidden);
        const keyCol = visibleCols.find(c => c.dataCategory === 'RowIdentifier') ||
                       visibleCols.find(c => /^id$/i.test(c.name) || /key$/i.test(c.name));

        return {
            name: t.name,
            description: t.description || '',
            isHidden: t.isHidden,
            isFP: t._isFieldParameter,
            isCG: t._isCalcGroup,
            columns: t.columns,
            measures: t.measures,
            hierarchies: t.hierarchies || [],
            critCount,
            warnCount,
            visualCount,
            sourceId,
            sourceName,
            keyCol: keyCol?.name || null,
        };
    }

    // ── Layout ────────────────────────────────────────────────────────────────

    _computeLayout(entities, relationships) {
        const COL_GAP = 60;
        const ROW_GAP = 80;
        const COLS = Math.max(1, Math.ceil(Math.sqrt(entities.length * 1.4)));

        // Sort: connected tables first, then by name
        const relCount = new Map();
        relationships.forEach(r => {
            relCount.set(r.fromTable, (relCount.get(r.fromTable) || 0) + 1);
            relCount.set(r.toTable,   (relCount.get(r.toTable) || 0) + 1);
        });
        const sorted = [...entities].sort((a, b) => {
            const ra = relCount.get(a.name) || 0;
            const rb = relCount.get(b.name) || 0;
            if (rb !== ra) return rb - ra;
            return a.name.localeCompare(b.name);
        });

        const positions = new Map();
        sorted.forEach((ent, i) => {
            const col = i % COLS;
            const row = Math.floor(i / COLS);
            positions.set(ent.name, {
                x: col * (this.NW + COL_GAP),
                y: row * (this.NH + ROW_GAP),
            });
        });

        // Light spring relaxation (20 passes)
        for (let pass = 0; pass < 20; pass++) {
            relationships.forEach(rel => {
                const a = positions.get(rel.fromTable);
                const b = positions.get(rel.toTable);
                if (!a || !b) return;
                const dx = b.x - a.x, dy = b.y - a.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const ideal = this.NW + COL_GAP;
                const force = (dist - ideal) * 0.04;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.x += fx; a.y += fy;
                b.x -= fx; b.y -= fy;
            });
            // Repulsion between all pairs
            sorted.forEach((e1, i) => {
                sorted.slice(i + 1).forEach(e2 => {
                    const a = positions.get(e1.name);
                    const b = positions.get(e2.name);
                    const dx = b.x - a.x, dy = b.y - a.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    if (dist < this.NW + COL_GAP) {
                        const rep = ((this.NW + COL_GAP) - dist) * 0.06;
                        const fx = (dx / dist) * rep;
                        const fy = (dy / dist) * rep;
                        a.x -= fx; a.y -= fy;
                        b.x += fx; b.y += fy;
                    }
                });
            });
        }

        // Normalize: shift all to non-negative
        let minX = Infinity, minY = Infinity;
        positions.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); });
        positions.forEach(p => { p.x -= minX; p.y -= minY; });

        // Data source nodes: place below entities
        const sourcePositions = new Map();
        let maxY = 0;
        positions.forEach(p => { maxY = Math.max(maxY, p.y + this.NH); });
        const sourceY = maxY + 80;
        const sources = [...new Set(entities.map(e => e.sourceId).filter(Boolean))];
        sources.forEach((srcId, i) => {
            sourcePositions.set(srcId, {
                x: i * (this.SW + 30),
                y: sourceY,
            });
        });

        let maxX = 0;
        positions.forEach(p => { maxX = Math.max(maxX, p.x + this.NW); });
        const canvasW = Math.max(maxX, sources.length * (this.SW + 30));
        const canvasH = sources.length > 0 ? sourceY + this.SH : maxY;

        return { positions, sourcePositions, canvasW, canvasH };
    }

    // ── SVG Drawing ───────────────────────────────────────────────────────────

    _drawEntityNode(g, ent) {
        const W = this.NW, H = this.NH;
        const hH = 42; // header height

        const headerColor = ent.isHidden ? this.C.hidden :
                            ent.isFP     ? this.C.fp :
                            ent.isCG     ? this.C.cg : this.C.entity;

        // Shadow
        g.appendChild(this._rect(3, 3, W, H, 6, 'rgba(0,0,0,0.12)', 'none'));
        // Body bg
        g.appendChild(this._rect(0, 0, W, H, 6, ent.isHidden ? this.C.bgHidden : this.C.bg, this.C.border));
        // Header bg (full rounded then cut bottom corners)
        g.appendChild(this._rect(0, 0, W, hH + 6, 6, headerColor, 'none'));
        g.appendChild(this._rect(0, hH - 2, W, 8, 0, headerColor, 'none'));

        // Type badge (top-left, tiny)
        const badgeLabel = ent.isFP ? 'FP' : ent.isCG ? 'CG' : ent.isHidden ? '👁' : 'ENTITY';
        const badgeW = ent.isFP || ent.isCG ? 26 : ent.isHidden ? 22 : 52;
        g.appendChild(this._rect(8, 7, badgeW, 14, 3, 'rgba(255,255,255,0.18)', 'none'));
        g.appendChild(this._text(8 + badgeW / 2, 18, badgeLabel,
            { fill: '#fff', 'font-size': '9', 'font-weight': '600', 'text-anchor': 'middle', 'font-family': 'monospace' }));

        // Table name
        const maxNameLen = 22;
        const displayName = ent.name.length > maxNameLen ? ent.name.slice(0, maxNameLen - 1) + '…' : ent.name;
        g.appendChild(this._text(W / 2, hH - 10, displayName,
            { fill: '#fff', 'font-size': '13', 'font-weight': '700', 'text-anchor': 'middle', 'font-family': 'sans-serif' }));

        // Body lines
        let y = hH + 14;

        // Data source line
        if (ent.sourceName) {
            g.appendChild(this._text(12, y, `⬡ ${ent.sourceName}`,
                { fill: this.C.source, 'font-size': '11', 'font-family': 'sans-serif' }));
            y += 16;
        }

        // Columns + measures
        const colStr = `${ent.columns.filter(c => !c.isHidden).length} cols`;
        const measStr = `∑ ${ent.measures.length} measures`;
        g.appendChild(this._text(12, y, colStr,
            { fill: this.C.textSub, 'font-size': '11', 'font-family': 'sans-serif' }));
        g.appendChild(this._text(W / 2 + 4, y, measStr,
            { fill: this.C.textSub, 'font-size': '11', 'font-family': 'sans-serif' }));
        y += 16;

        // Key column
        if (ent.keyCol) {
            g.appendChild(this._text(12, y, `🔑 ${ent.keyCol}`,
                { fill: this.C.textSub, 'font-size': '10', 'font-family': 'sans-serif' }));
            y += 14;
        }

        // Description (truncated)
        if (ent.description) {
            const desc = ent.description.length > 32 ? ent.description.slice(0, 31) + '…' : ent.description;
            g.appendChild(this._text(12, y, desc,
                { fill: '#888', 'font-size': '10', 'font-style': 'italic', 'font-family': 'sans-serif' }));
        }

        // Footer divider
        g.appendChild(this._el('line', {
            x1: 0, y1: H - 24, x2: W, y2: H - 24,
            stroke: this.C.border, 'stroke-width': 1
        }));

        // BPA badge
        if (ent.critCount > 0) {
            g.appendChild(this._rect(8, H - 20, 42, 14, 3, this.C.crit, 'none'));
            g.appendChild(this._text(29, H - 9, `⚠ ${ent.critCount} crit`,
                { fill: '#fff', 'font-size': '9', 'font-weight': '600', 'text-anchor': 'middle', 'font-family': 'sans-serif' }));
        } else if (ent.warnCount > 0) {
            g.appendChild(this._rect(8, H - 20, 40, 14, 3, this.C.warn, 'none'));
            g.appendChild(this._text(28, H - 9, `⚠ ${ent.warnCount} warn`,
                { fill: '#111', 'font-size': '9', 'font-weight': '600', 'text-anchor': 'middle', 'font-family': 'sans-serif' }));
        } else {
            g.appendChild(this._text(12, H - 9, '✓ BPA OK',
                { fill: this.C.accent, 'font-size': '9', 'font-weight': '600', 'font-family': 'sans-serif' }));
        }

        // Visual usage badge (right)
        if (ent.visualCount > 0) {
            g.appendChild(this._text(W - 8, H - 9, `👁 ${ent.visualCount}`,
                { fill: this.C.textSub, 'font-size': '10', 'text-anchor': 'end', 'font-family': 'sans-serif' }));
        }
    }

    _drawSourceNode(g, sourceId, pos) {
        g.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
        const label = sourceId.replace('source:', '').split('|')[0];
        g.appendChild(this._rect(0, 0, this.SW, this.SH, 5, '#e8f5e9', '#81c784'));
        g.appendChild(this._text(this.SW / 2, 16, '💾 DATA SOURCE',
            { fill: this.C.source, 'font-size': '9', 'font-weight': '700', 'text-anchor': 'middle', 'font-family': 'monospace' }));
        const display = label.length > 18 ? label.slice(0, 17) + '…' : label;
        g.appendChild(this._text(this.SW / 2, 32, display,
            { fill: this.C.source, 'font-size': '12', 'font-weight': '600', 'text-anchor': 'middle', 'font-family': 'sans-serif' }));
    }

    _drawRelEdge(g, rel, fromPos, toPos) {
        const NW = this.NW, NH = this.NH;
        // Connect center-bottom of from to center-top of to (or sides if horizontal)
        const fx = fromPos.x + NW / 2, fy = fromPos.y + NH / 2;
        const tx = toPos.x + NW / 2,   ty = toPos.y + NH / 2;

        // Pick edge midpoints on node borders
        const dx = tx - fx, dy = ty - fy;
        const fromEdge = this._borderPoint(fromPos, NW, NH, dx, dy, false);
        const toEdge   = this._borderPoint(toPos,   NW, NH, -dx, -dy, true);

        const edgeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        edgeG.setAttribute('class', 'ontology-edge');

        const isManyToMany = rel.fromCardinality === 'many' && rel.toCardinality === 'many';
        const strokeColor = isManyToMany ? '#e57373' : '#90a4ae';

        const path = this._el('path', {
            d: `M ${fromEdge.x} ${fromEdge.y} C ${(fromEdge.x + toEdge.x) / 2} ${fromEdge.y} ${(fromEdge.x + toEdge.x) / 2} ${toEdge.y} ${toEdge.x} ${toEdge.y}`,
            stroke: strokeColor, 'stroke-width': '1.5', fill: 'none',
            'marker-end': 'url(#ontology-arrow)',
        });
        if (isManyToMany) path.setAttribute('stroke-dasharray', '5 3');

        edgeG.appendChild(path);

        // Cardinality labels
        const cardFrom = rel.fromCardinality === 'many' ? '*' : '1';
        const cardTo   = rel.toCardinality   === 'many' ? '*' : '1';
        const midX = (fromEdge.x + toEdge.x) / 2;
        const midY = (fromEdge.y + toEdge.y) / 2;

        const cardBg = this._rect(midX - 14, midY - 9, 28, 14, 3, '#fff', '#c0c0c0');
        cardBg.setAttribute('opacity', '0.9');
        edgeG.appendChild(cardBg);
        edgeG.appendChild(this._text(midX, midY + 3, `${cardFrom}:${cardTo}`,
            { fill: '#555', 'font-size': '9', 'font-weight': '600', 'text-anchor': 'middle', 'font-family': 'monospace' }));

        g.appendChild(edgeG);
    }

    _borderPoint(pos, w, h, dx, dy, isTarget) {
        const cx = pos.x + w / 2, cy = pos.y + h / 2;
        if (Math.abs(dx) * h > Math.abs(dy) * w) {
            // Horizontal dominant
            const side = dx > 0 ? 1 : -1;
            return { x: cx + side * w / 2, y: cy + dy * (w / 2) / Math.abs(dx) };
        } else {
            // Vertical dominant
            const side = dy > 0 ? 1 : -1;
            return { x: cx + dx * (h / 2) / Math.abs(dy), y: cy + side * h / 2 };
        }
    }

    _addMarkers(svg) {
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', 'ontology-arrow');
        marker.setAttribute('markerWidth', '8');
        marker.setAttribute('markerHeight', '8');
        marker.setAttribute('refX', '6');
        marker.setAttribute('refY', '3');
        marker.setAttribute('orient', 'auto');
        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        arrow.setAttribute('d', 'M0,0 L0,6 L8,3 z');
        arrow.setAttribute('fill', '#90a4ae');
        marker.appendChild(arrow);
        defs.appendChild(marker);
        svg.appendChild(defs);
    }

    // ── Zoom / Pan ────────────────────────────────────────────────────────────

    _initZoomPan(svg, container) {
        const vb = { x: 0, y: 0, w: parseFloat(svg.getAttribute('width')), h: parseFloat(svg.getAttribute('height')) };

        const setVB = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);

        const zoom = (factor, cx, cy) => {
            if (!cx) { cx = vb.x + vb.w / 2; cy = vb.y + vb.h / 2; }
            const nw = Math.max(200, Math.min(vb.w * factor, 8000));
            const nh = nw * (vb.h / vb.w);
            vb.x = cx - (cx - vb.x) * (nw / vb.w);
            vb.y = cy - (cy - vb.y) * (nh / vb.h);
            vb.w = nw; vb.h = nh;
            setVB();
        };

        const zoomIn  = container.querySelector('[data-ontology-zoom="in"]');
        const zoomOut = container.querySelector('[data-ontology-zoom="out"]');
        const zoomReset = container.querySelector('[data-ontology-zoom="reset"]');
        if (zoomIn)    zoomIn.addEventListener('click', () => zoom(0.7));
        if (zoomOut)   zoomOut.addEventListener('click', () => zoom(1.4));
        if (zoomReset) {
            zoomReset.addEventListener('click', () => {
                vb.x = 0; vb.y = 0;
                vb.w = parseFloat(svg.getAttribute('width'));
                vb.h = parseFloat(svg.getAttribute('height'));
                setVB();
            });
        }

        // Wheel zoom
        const onWheel = (e) => {
            e.preventDefault();
            const rect = svg.getBoundingClientRect();
            const scale = vb.w / rect.width;
            const cx = vb.x + (e.clientX - rect.left) * scale;
            const cy = vb.y + (e.clientY - rect.top)  * scale;
            zoom(e.deltaY > 0 ? 1.15 : 0.87, cx, cy);
        };
        svg.addEventListener('wheel', onWheel, { passive: false });

        // Pan
        let dragging = false, lastX = 0, lastY = 0;
        const onDown = (e) => {
            if (e.target.closest('.ontology-node') || e.target.closest('.ontology-source-node')) return;
            dragging = true; lastX = e.clientX; lastY = e.clientY;
            svg.style.cursor = 'grabbing';
        };
        const onMove = (e) => {
            if (!dragging) return;
            const rect = svg.getBoundingClientRect();
            const scale = vb.w / rect.width;
            vb.x -= (e.clientX - lastX) * scale;
            vb.y -= (e.clientY - lastY) * scale;
            lastX = e.clientX; lastY = e.clientY;
            setVB();
        };
        const onUp = () => { dragging = false; svg.style.cursor = 'grab'; };

        svg.style.cursor = 'grab';
        svg.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);

        this._cleanupFn = () => {
            svg.removeEventListener('wheel', onWheel);
            svg.removeEventListener('mousedown', onDown);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }

    // ── Node click → detail panel ─────────────────────────────────────────────

    _initNodeClicks(svg, entities, container) {
        const panel = container.querySelector('.ontology-detail');
        svg.addEventListener('click', (e) => {
            const node = e.target.closest('.ontology-node');
            if (!node) {
                // Click on empty space — deselect
                svg.querySelectorAll('.ontology-node').forEach(n => n.classList.remove('ont-selected'));
                if (panel) panel.classList.add('hidden');
                return;
            }
            const name = node.dataset.entity;
            const ent = entities.find(e => e.name === name);
            if (!ent) return;

            svg.querySelectorAll('.ontology-node').forEach(n => n.classList.remove('ont-selected'));
            node.classList.add('ont-selected');
            this._renderDetailPanel(panel, ent);
            panel.classList.remove('hidden');
        });
    }

    _renderDetailPanel(panel, ent) {
        const table = this.model.tables.find(t => t.name === ent.name);
        if (!panel || !table) return;

        const bpaIssues = (this.bpaResults?.findings || []).filter(f => f.table === ent.name);

        const visibleCols = table.columns.filter(c => !c.isHidden);
        const allCols = table.columns;

        const typeIcon = ent.isFP ? '⬡ Field Parameter' : ent.isCG ? '⚙ Calculation Group' : ent.isHidden ? '🔒 Hidden Table' : '📦 Entity';

        let html = `
        <div class="ont-detail-header">
            <div>
                <span class="ont-detail-type">${typeIcon}</span>
                <h3 class="ont-detail-name">${this._esc(ent.name)}</h3>
            </div>
            <button class="ont-detail-close" onclick="this.closest('.ontology-detail').classList.add('hidden')">×</button>
        </div>`;

        if (ent.description) {
            html += `<p class="ont-detail-desc">${this._esc(ent.description)}</p>`;
        }

        // Stats row
        html += `<div class="ont-stat-row">
            <div class="ont-stat"><strong>${visibleCols.length}</strong><span>Visible columns</span></div>
            <div class="ont-stat"><strong>${allCols.length - visibleCols.length}</strong><span>Hidden columns</span></div>
            <div class="ont-stat"><strong>${table.measures.length}</strong><span>Measures</span></div>
            <div class="ont-stat"><strong>${ent.visualCount}</strong><span>Visual uses</span></div>
        </div>`;

        if (ent.sourceName) {
            html += `<div class="ont-section-label">DATA SOURCE</div>
            <div class="ont-source-chip">💾 ${this._esc(ent.sourceName)}</div>`;
        }

        // Columns
        if (visibleCols.length > 0) {
            html += `<div class="ont-section-label">PROPERTIES (${visibleCols.length} visible)</div>
            <div class="ont-col-list">`;
            visibleCols.slice(0, 15).forEach(c => {
                const typeTag = c.dataType ? `<span class="ont-dtype">${this._esc(c.dataType)}</span>` : '';
                const keyMark = c.name === ent.keyCol ? ' 🔑' : '';
                html += `<div class="ont-col-row">${typeTag}<span>${this._esc(c.name)}${keyMark}</span></div>`;
            });
            if (visibleCols.length > 15) {
                html += `<div class="ont-col-row" style="color:var(--text-light);font-style:italic">+${visibleCols.length - 15} more…</div>`;
            }
            html += `</div>`;
        }

        // Measures
        if (table.measures.length > 0) {
            html += `<div class="ont-section-label">KPI / MEASURES (${table.measures.length})</div>
            <div class="ont-col-list">`;
            table.measures.slice(0, 10).forEach(m => {
                const fmt = m.formatString ? `<span class="ont-dtype">${this._esc(m.formatString)}</span>` : '';
                html += `<div class="ont-col-row">${fmt}<span>∑ ${this._esc(m.name)}</span></div>`;
            });
            if (table.measures.length > 10) {
                html += `<div class="ont-col-row" style="color:var(--text-light);font-style:italic">+${table.measures.length - 10} more…</div>`;
            }
            html += `</div>`;
        }

        // Relationships
        const rels = this.model.relationships.filter(r => r.fromTable === ent.name || r.toTable === ent.name);
        if (rels.length > 0) {
            html += `<div class="ont-section-label">RELATIONSHIPS (${rels.length})</div><div class="ont-col-list">`;
            rels.forEach(r => {
                const other = r.fromTable === ent.name ? r.toTable : r.fromTable;
                const dir   = r.fromTable === ent.name ? '→' : '←';
                const card  = `${r.fromCardinality || '?'}:${r.toCardinality || '?'}`;
                html += `<div class="ont-col-row"><span class="ont-dtype">${card}</span><span>${dir} ${this._esc(other)}</span></div>`;
            });
            html += `</div>`;
        }

        // BPA issues
        if (bpaIssues.length > 0) {
            html += `<div class="ont-section-label">BPA ISSUES (${bpaIssues.length})</div><div class="ont-col-list">`;
            bpaIssues.slice(0, 5).forEach(f => {
                const color = f.severity === 3 ? '#da291c' : f.severity === 2 ? '#ff8f00' : '#888';
                html += `<div class="ont-col-row"><span class="ont-dtype" style="background:${color};color:#fff">${f.severity === 3 ? 'CRIT' : f.severity === 2 ? 'WARN' : 'INFO'}</span><span style="font-size:11px">${this._esc(f.message)}</span></div>`;
            });
            html += `</div>`;
        }

        panel.innerHTML = html;
    }

    // ── Fabric IQ JSON export ─────────────────────────────────────────────────

    exportFabricIQ() {
        const m = this.model;
        const entities = m.tables.filter(t => !t._isAutoDate).map((t, i) => ({
            id: String(1000000000000 + i),
            namespace: 'usertypes',
            namespaceType: 'Custom',
            name: t.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
            displayName: t.name,
            description: t.description || '',
            visibility: t.isHidden ? 'Hidden' : 'Visible',
            properties: t.columns.map((c, ci) => ({
                id: String(2000000000000 + i * 1000 + ci),
                name: c.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
                displayName: c.name,
                valueType: this._mapDataType(c.dataType),
                description: c.description || '',
            })),
            measures: t.measures.map(ms => ({
                name: ms.name,
                expression: ms.expression,
                formatString: ms.formatString || '',
                description: ms.description || '',
            })),
        }));

        const idMap = new Map(entities.map(e => [e.displayName, e.id]));

        const relationships = m.relationships.map((r, i) => ({
            id: String(3000000000000 + i),
            namespace: 'usertypes',
            namespaceType: 'Custom',
            name: `${r.fromTable}_${r.fromColumn}_${r.toTable}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
            fromCardinality: r.fromCardinality || 'one',
            toCardinality: r.toCardinality || 'many',
            source: { entityTypeId: idMap.get(r.fromTable) || '0' },
            target: { entityTypeId: idMap.get(r.toTable)   || '0' },
        }));

        return {
            $schema: 'pbip-semlin/ontology/v1',
            generatedAt: new Date().toISOString(),
            model: m.database?.name || m.model?.name || 'Semantic Model',
            entityTypes: entities,
            relationshipTypes: relationships,
        };
    }

    _mapDataType(dt) {
        if (!dt) return 'String';
        const map = {
            'Int64': 'BigInt', 'Integer': 'BigInt',
            'Double': 'Double', 'Decimal': 'Double', 'Currency': 'Double',
            'Boolean': 'Boolean',
            'DateTime': 'DateTime', 'Date': 'DateTime',
        };
        return map[dt] || 'String';
    }

    // ── SVG helpers ───────────────────────────────────────────────────────────

    _el(tag, attrs) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        return el;
    }
    _rect(x, y, w, h, rx, fill, stroke) {
        return this._el('rect', { x, y, width: w, height: h, rx, fill, stroke: stroke || 'none', 'stroke-width': 1 });
    }
    _text(x, y, content, attrs) {
        const t = this._el('text', { x, y, ...attrs });
        t.textContent = content;
        return t;
    }
    _esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}

'use strict';

class OntologyRenderer {
    constructor(model, lineageEngine, visualData, bpaResults) {
        this.model          = model;
        this.lineageEngine  = lineageEngine;
        this.visualData     = visualData;
        this.bpaResults     = bpaResults;
        this._nodes         = [];
        this._edges         = [];
        this._simulation    = null;
        this._svgEl         = null;
        this._root          = null;
        this._spokesLayer   = null;
        this._colEdgesLayer = null;
        this._satLayer      = null;
        this._defs          = null;
        this._container     = null;
        this._W = 900; this._H = 600;
        this._tx = 0;  this._ty = 0;  this._scale = 1;
        this._showHidden    = false;
        this._showReports   = false;
        this._reportFilter  = false;
        this._reportUsedSet = new Set();
        this._colEdgeMap    = new Map();
        this._dragging      = null;
        this._highlightSet  = null;
        this._onMouseMove   = null;
        this._onMouseUp     = null;
    }

    destroy() {
        if (this._simulation) { this._simulation.stop(); this._simulation = null; }
        if (this._onMouseMove) window.removeEventListener('mousemove', this._onMouseMove);
        if (this._onMouseUp)   window.removeEventListener('mouseup',   this._onMouseUp);
        this._onMouseMove = null;
        this._onMouseUp   = null;
    }

    render(container) {
        this.destroy();
        this._container = container;
        container.innerHTML = '';

        const { nodes, edges } = this._buildGraph();
        this._nodes = nodes;
        this._edges = edges;
        this._nodes.forEach((n, i) => { n._idx = i; });

        const W = container.clientWidth  || 900;
        const H = container.clientHeight || 580;
        this._W = W; this._H = H;

        const initR = Math.min(W, H) * 0.3;
        nodes.forEach((node, i) => {
            const angle = (2 * Math.PI * i / Math.max(nodes.length, 1)) - Math.PI / 2;
            node.x  = Math.cos(angle) * initR + (Math.random() - 0.5) * 20;
            node.y  = Math.sin(angle) * initR + (Math.random() - 0.5) * 20;
            node.vx = 0; node.vy = 0;
        });

        const svg = this._mkSVG('svg', { width: '100%', height: '100%' });
        svg.style.cursor = 'grab';
        this._svgEl = svg;
        this._addDefs(svg);

        const root = this._mkSVG('g', { id: 'ont-root' });
        svg.appendChild(root);
        this._root = root;

        const edgeLayer     = this._mkSVG('g', { id: 'ont-edges' });
        const spokesLayer   = this._mkSVG('g', { id: 'ont-spokes' });
        const colEdgesLayer = this._mkSVG('g', { id: 'ont-col-edges' });
        const nodeLayer     = this._mkSVG('g', { id: 'ont-nodes' });
        const satLayer      = this._mkSVG('g', { id: 'ont-satellites' });
        [edgeLayer, spokesLayer, colEdgesLayer, nodeLayer, satLayer].forEach(l => root.appendChild(l));
        this._spokesLayer   = spokesLayer;
        this._colEdgesLayer = colEdgesLayer;
        this._satLayer      = satLayer;
        this._colEdgeMap    = new Map();

        this._createEdgeElements(edgeLayer);
        this._createNodeElements(nodeLayer, container);
        this._setHiddenVisibility(false);
        // Default on: show report pages + report-used filter
        if (this._nodes.some(n => n._isReport)) {
            this._setReportVisibility(true);
            this._setReportFilter(true);
        }

        container.appendChild(svg);
        this._applyRootTransform();

        this._initInteraction(svg, container);
        this._setupSimulation();

        root.style.opacity   = '0';
        root.style.transition = 'opacity 0.5s ease';
        requestAnimationFrame(() => { root.style.opacity = '1'; });

        this._addLegend(container);

        const panel = document.createElement('div');
        panel.className = 'ontology-detail';
        panel.id        = 'ontologyDetailPanel';
        panel.style.display = 'none';
        container.appendChild(panel);
    }

    // ─── D3 Force Simulation ─────────────────────────────────────────────────

    _setupSimulation() {
        const nodes = this._nodes;
        const edges = this._edges;

        // Relationship edges only — report edges handled by custom force
        const links = edges
            .filter(e => !e._isReportEdge)
            .map(e => ({ source: e.from, target: e.to }));

        this._simulation = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(links)
                .id((_, i) => i)
                .distance(260)
                .strength(0.032))
            .force('charge', d3.forceManyBody()
                .strength(d => d._isReport ? -600 : -2800)
                .distanceMax(700))
            .force('center', d3.forceCenter(0, 0).strength(0.05))
            .force('collide', d3.forceCollide()
                .radius(d => (d.expanded ? d.radius + 200 : d.radius) + 28)
                .strength(0.8)
                .iterations(2))
            .force('radial', d3.forceRadial(
                d => d._isReport ? 380 : 220, 0, 0
            ).strength(0.04))
            .alphaDecay(0.026)
            .velocityDecay(0.4)
            .on('tick', () => this._updateDOM());

        // One-way report attraction (custom force — doesn't push tables)
        this._simulation.force('reportAttr', () => {
            if (!this._showReports) return;
            nodes.forEach(rn => {
                if (!rn._isReport || !this._nodeActive(rn)) return;
                let cx = 0, cy = 0, cnt = 0;
                edges.forEach(e => {
                    if (!e._isReportEdge) return;
                    const other = e.from === rn._idx ? nodes[e.to]
                                : e.to   === rn._idx ? nodes[e.from] : null;
                    if (other && this._nodeActive(other)) { cx += other.x; cy += other.y; cnt++; }
                });
                if (cnt > 0) { rn.vx += 0.01 * (cx / cnt - rn.x); rn.vy += 0.01 * (cy / cnt - rn.y); }
            });
        });
    }

    _reheatSimulation(alpha = 0.3) {
        if (!this._simulation) return;
        // Update collide radius in case expansion state changed
        this._simulation.force('collide')
            .radius(d => (d.expanded ? d.radius + 200 : d.radius) + 28);
        this._simulation.alphaTarget(alpha).restart();
        setTimeout(() => { if (this._simulation) this._simulation.alphaTarget(0); }, 1400);
    }

    _applyRootTransform() {
        if (!this._root) return;
        this._root.setAttribute('transform',
            `translate(${this._W / 2 + this._tx},${this._H / 2 + this._ty}) scale(${this._scale})`);
    }

    // ─── Graph data ──────────────────────────────────────────────────────────

    _buildGraph() {
        const model  = this.model;
        const tables = (model.tables || []).filter(t => !t._isAutoDate);

        const STYLES = {
            entity:     { color: '#2563eb', light: '#93c5fd', dark: '#1e40af' },
            fieldparam: { color: '#7c3aed', light: '#c4b5fd', dark: '#5b21b6' },
            calcgroup:  { color: '#ea580c', light: '#fdba74', dark: '#9a3412' },
            hidden:     { color: '#64748b', light: '#cbd5e1', dark: '#334155' },
        };

        const nodes = tables.map(t => {
            let typeKey = 'entity';
            if (t._isFieldParameter) typeKey = 'fieldparam';
            else if (t._isCalcGroup) typeKey = 'calcgroup';
            else if (t.isHidden)     typeKey = 'hidden';

            const s          = STYLES[typeKey];
            const cols       = (t.columns || []).filter(c => !c.isHidden);
            const hiddenCols = (t.columns || []).filter(c =>  c.isHidden);
            const measures   = t.measures || [];
            const complexity = Math.min(cols.length + measures.length * 1.8, 90);
            const radius     = Math.round(Math.max(32, Math.min(50, 30 + complexity * 0.22)));

            const words    = t.name.replace(/[_-]/g, ' ').trim().split(/\s+/);
            const initials = words.length >= 2
                ? (words[0][0] + words[1][0]).toUpperCase()
                : t.name.slice(0, 2).toUpperCase();

            return {
                id: t.name, name: t.name, table: t,
                typeKey, ...s, radius,
                cols, hiddenCols, measures, initials,
                expanded: false, satellites: [],
                x: 0, y: 0, vx: 0, vy: 0,
                _pinned: false, _grp: null, _circle: null, _selected: false,
                _hideNode: typeKey === 'hidden'
            };
        });

        const idx = {};
        nodes.forEach((n, i) => { idx[n.id] = i; });

        const edges = (model.relationships || [])
            .map(rel => {
                const fi = idx[rel.fromTable];
                const ti = idx[rel.toTable];
                if (fi == null || ti == null || fi === ti) return null;
                const c1 = rel.fromCardinality === 'Many' ? '*' : '1';
                const c2 = rel.toCardinality   === 'Many' ? '*' : '1';
                return { from: fi, to: ti, rel, card: `${c1}:${c2}`, _path: null, _label: null };
            })
            .filter(Boolean);

        // ── Report usage ──────────────────────────────────────────────────────
        const fum = this.visualData?.fieldUsageMap;

        nodes.forEach(n => {
            n._usedInReports = false;
            if (fum) {
                for (const key of Object.keys(fum)) {
                    if (key.split('|')[1] === n.name) { n._usedInReports = true; break; }
                }
            }
        });

        this._reportUsedSet = new Set();
        if (fum) {
            for (const key of Object.keys(fum)) {
                const [type, table, field] = key.split('|');
                if (type === 'measure' || type === 'column') {
                    this._reportUsedSet.add(`${table}::${field}`);
                }
            }
        }

        const MAX_RPT = 30;
        if (this.visualData?.pages) {
            this.visualData.pages.slice(0, MAX_RPT).forEach((page, pi) => {
                const tablesInPage     = new Set();
                const fieldsInPage     = new Set(); // "tName|fieldName"
                const tablesWithFields = new Set(); // tables where ≥1 field name was identified

                (page.visuals || []).forEach(v => {
                    (v.fields || []).forEach(f => {
                        const t = f.table || f.entity || f.Entity;
                        if (!t || idx[t] === undefined) return;
                        tablesInPage.add(t);
                        // Try all known PBIR field-name properties
                        const fieldName = f.column || f.measure || f.attribute
                                       || f.name   || f.field   || f.queryRef;
                        if (fieldName) {
                            // queryRef may be "Table.Field" — strip the table prefix
                            const clean = fieldName.includes('.') ? fieldName.split('.').pop() : fieldName;
                            fieldsInPage.add(`${t}|${clean}`);
                            tablesWithFields.add(t);
                        }
                    });
                });
                if (tablesInPage.size === 0) return;

                const pageName = page.displayName || page.name || `Page ${pi + 1}`;
                const words    = pageName.replace(/[_-]/g, ' ').trim().split(/\s+/);
                const initials = words.length >= 2
                    ? (words[0][0] + words[1][0]).toUpperCase()
                    : pageName.slice(0, 2).toUpperCase();

                const rNodeIdx = nodes.length;
                nodes.push({
                    id: `_rpt_${page.id || pi}`, name: pageName,
                    typeKey: 'report',
                    color: '#0ea5e9', light: '#bae6fd', dark: '#0369a1',
                    radius: 26, cols: [], hiddenCols: [], measures: [],
                    initials, expanded: false, satellites: [],
                    x: 0, y: 0, vx: 0, vy: 0,
                    _pinned: false, _grp: null, _circle: null, _selected: false,
                    _hideNode: false, _isReport: true, _usedInReports: true,
                    page, _visualCount: (page.visuals || []).length,
                    _tableCount: tablesInPage.size
                });

                // Per-field edges for every field we could identify
                fieldsInPage.forEach(key => {
                    const pipe = key.indexOf('|');
                    edges.push({ from: rNodeIdx, to: idx[key.slice(0, pipe)],
                        rel: null, card: '', _path: null, _label: null,
                        _isReportEdge: true, _reportField: key.slice(pipe + 1) });
                });

                // Table-level fallback for tables where field extraction failed entirely
                tablesInPage.forEach(tName => {
                    if (!tablesWithFields.has(tName)) {
                        edges.push({ from: rNodeIdx, to: idx[tName],
                            rel: null, card: '', _path: null, _label: null,
                            _isReportEdge: true });
                    }
                });
            });
        }

        return { nodes, edges };
    }

    // Build satellite descriptors for a table node (lazily on first expand)
    _buildSatellites(node) {
        const sats    = [];
        const INNER_R = node.radius + 72;
        const OUTER_R = node.radius + 152;

        const cols = [...node.cols].sort((a, b) => {
            if (a.isKey && !b.isKey) return -1;
            if (!a.isKey && b.isKey) return 1;
            return a.name.localeCompare(b.name);
        });
        const totalColSlots = cols.length;

        const colIdx = new Map();
        cols.forEach((c, i) => colIdx.set(c.name, i));

        cols.forEach((c, i) => {
            sats.push({
                type: 'column', name: c.name, col: c,
                color: this._colTypeColor(c.dataType), radius: 11,
                orbitR: INNER_R,
                angle: (2 * Math.PI * i / Math.max(totalColSlots, 1)) - Math.PI / 2,
                x: node.x, y: node.y, _grp: null, _spoke: null
            });
        });

        const showMsrs = node.measures.slice();
        showMsrs.sort((a, b) =>
            this._msrBarycenter(a, node.name, colIdx, cols.length) -
            this._msrBarycenter(b, node.name, colIdx, cols.length)
        );
        const totalMsrSlots = showMsrs.length;

        showMsrs.forEach((m, i) => {
            sats.push({
                type: 'measure', name: m.name, measure: m,
                color: '#7c3aed', radius: 19,
                orbitR: OUTER_R,
                angle: (2 * Math.PI * i / Math.max(totalMsrSlots, 1)) - Math.PI / 2,
                x: node.x, y: node.y, _grp: null, _spoke: null,
                colRefs: this._parseDaxColumnRefs(m.expression || '', node.name)
            });
        });

        return sats;
    }

    _parseDaxColumnRefs(expr, defaultTable) {
        const refs = []; const seen = new Set();
        const re = /(\w[\w\s]*?)\s*\[([^\]]+)\]/g;
        let m;
        while ((m = re.exec(expr)) !== null) {
            const key = `${m[1].trim()}::${m[2].trim()}`;
            if (!seen.has(key)) { seen.add(key); refs.push({ tableName: m[1].trim(), colName: m[2].trim() }); }
        }
        const stripped = expr.replace(/\w[\w\s]*?\s*\[[^\]]+\]/g, '');
        const re2 = /\[([^\]]+)\]/g;
        while ((m = re2.exec(stripped)) !== null) {
            const key = `${defaultTable}::${m[1].trim()}`;
            if (!seen.has(key)) { seen.add(key); refs.push({ tableName: defaultTable, colName: m[1].trim() }); }
        }
        return refs;
    }

    _msrBarycenter(measure, tableName, colIdx, numCols) {
        if (!measure.expression) return numCols;
        const refs = this._parseDaxColumnRefs(measure.expression, tableName)
            .filter(r => r.tableName === tableName && colIdx.has(r.colName));
        if (refs.length === 0) return numCols;
        return refs.reduce((s, r) => s + colIdx.get(r.colName), 0) / refs.length;
    }

    _colTypeColor(dt) {
        const t = (dt || '').toLowerCase();
        if (['int64','int32','integer','double','decimal','currency','single'].includes(t)) return '#16a34a';
        if (['string','text'].includes(t))    return '#0891b2';
        if (['datetime','date','time'].includes(t)) return '#e11d48';
        if (['boolean'].includes(t))          return '#f59e0b';
        return '#94a3b8';
    }

    // ─── Expand / collapse ───────────────────────────────────────────────────

    _toggleExpand(nodeIdx, container) {
        const node = this._nodes[nodeIdx];
        node.expanded = !node.expanded;

        if (node.expanded) {
            if (node.satellites.length === 0) node.satellites = this._buildSatellites(node);
            node.satellites.forEach(sat => {
                const vis = this._satVisible(node, sat);
                if (!sat._grp) {
                    this._createSatelliteElement(sat, node, container);
                    if (!vis) { sat._grp.style.display = 'none'; if (sat._spoke) sat._spoke.style.display = 'none'; }
                } else {
                    sat._grp.style.display  = vis ? '' : 'none';
                    if (sat._spoke) sat._spoke.style.display = vis ? '' : 'none';
                }
            });
            this._reheatSimulation(0.35);
        } else {
            node.satellites.forEach(sat => {
                if (sat._grp)   sat._grp.style.display   = 'none';
                if (sat._spoke) sat._spoke.style.display = 'none';
            });
            if (node._msrTrunkEl) node._msrTrunkEl.style.display = 'none';
        }

        if (node._expandDot) node._expandDot.setAttribute('fill', node.expanded ? node.color : 'white');
    }

    _createSatelliteElement(sat, parentNode, container) {
        // Dotted spoke — column spokes only; measures use bundled trunk
        let spoke = null;
        if (sat.type !== 'measure') {
            spoke = this._mkSVG('line', {
                stroke: parentNode.color, 'stroke-width': '1',
                'stroke-dasharray': '2,4', opacity: '0.45'
            });
            this._spokesLayer.appendChild(spoke);
        }
        sat._spoke = spoke;

        const R   = sat.radius;
        const grp = this._mkSVG('g');
        grp.classList.add('ont-sat-grp');
        grp.style.cursor     = 'pointer';
        grp.style.transition = 'opacity 0.2s ease';

        if (sat.type === 'column') {
            const circle = this._mkSVG('circle', { r: R, fill: sat.color, opacity: '0.88', stroke: 'white', 'stroke-width': '1.5' });
            const title  = this._mkSVG('title');
            title.textContent = `${sat.name}  (${sat.col.dataType || '?'})`;
            grp.appendChild(circle); grp.appendChild(title);

        } else if (sat.type === 'measure') {
            const gid  = `sat-g-${Math.random().toString(36).slice(2)}`;
            const grad = this._mkSVG('radialGradient', { id: gid, cx: '38%', cy: '32%', r: '68%' });
            const s1   = this._mkSVG('stop', { offset: '0%' });   s1.setAttribute('stop-color', '#c4b5fd');
            const s2   = this._mkSVG('stop', { offset: '100%' }); s2.setAttribute('stop-color', '#5b21b6');
            grad.appendChild(s1); grad.appendChild(s2);
            this._defs.appendChild(grad);

            const circle = this._mkSVG('circle', { r: R, fill: `url(#${gid})`, stroke: '#7c3aed', 'stroke-width': '1.5' });
            const sym    = this._mkSVG('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': '11', fill: 'white', 'pointer-events': 'none', 'font-weight': '700' });
            sym.textContent = 'Σ';
            const lbl = this._mkSVG('text', { 'text-anchor': 'middle', 'dominant-baseline': 'hanging', 'font-size': '9', 'font-weight': '500', fill: 'var(--text, #1e293b)', 'pointer-events': 'none', y: R + 4 });
            lbl.textContent = sat.name.length > 14 ? sat.name.slice(0, 12) + '…' : sat.name;
            grp.appendChild(circle); grp.appendChild(sym); grp.appendChild(lbl);

        } else {
            const circle = this._mkSVG('circle', { r: R, fill: 'var(--surface,#fff)', stroke: sat.color, 'stroke-width': '1.5', 'stroke-dasharray': '3,2', opacity: '0.8' });
            const txt    = this._mkSVG('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': '8', fill: '#64748b', 'pointer-events': 'none', 'font-weight': '700' });
            txt.textContent = sat.name;
            grp.appendChild(circle); grp.appendChild(txt);
        }

        if (!sat.type.startsWith('more')) {
            grp.addEventListener('click', e => { e.stopPropagation(); this._selectSatellite(parentNode, sat, container); });
        }

        this._satLayer.appendChild(grp);
        sat._grp = grp;
    }

    // ─── Defs & node creation ────────────────────────────────────────────────

    _addDefs(svg) {
        const defs = this._mkSVG('defs');
        this._defs = defs;

        const mk = this._mkSVG('marker', { id: 'ont-arrow', markerWidth: '10', markerHeight: '7', refX: '9', refY: '3.5', orient: 'auto' });
        mk.appendChild(this._mkSVG('polygon', { points: '0 0,10 3.5,0 7', fill: '#94a3b8' }));
        defs.appendChild(mk);

        const fGlow = this._mkSVG('filter', { id: 'ont-glow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
        const feGB  = this._mkSVG('feGaussianBlur', { stdDeviation: '7', result: 'coloredBlur' });
        const feMerge = this._mkSVG('feMerge');
        feMerge.appendChild(this._mkSVG('feMergeNode', { in: 'coloredBlur' }));
        feMerge.appendChild(this._mkSVG('feMergeNode', { in: 'SourceGraphic' }));
        fGlow.appendChild(feGB); fGlow.appendChild(feMerge);
        defs.appendChild(fGlow);

        const fShadow = this._mkSVG('filter', { id: 'ont-shadow', x: '-30%', y: '-30%', width: '160%', height: '160%' });
        fShadow.appendChild(this._mkSVG('feDropShadow', { dx: '2', dy: '3', stdDeviation: '4', 'flood-opacity': '0.22' }));
        defs.appendChild(fShadow);

        svg.appendChild(defs);
    }

    _createNodeElements(nodeLayer, container) {
        this._nodes.forEach((node, i) => {
            const R = node.radius;

            const gid  = `ont-grad-${i}`;
            const grad = this._mkSVG('radialGradient', { id: gid, cx: '38%', cy: '32%', r: '68%' });
            const s1 = this._mkSVG('stop', { offset: '0%' });   s1.setAttribute('stop-color', node.light);
            const s2 = this._mkSVG('stop', { offset: '100%' }); s2.setAttribute('stop-color', node.dark);
            grad.appendChild(s1); grad.appendChild(s2);
            this._defs.appendChild(grad);

            const grp = this._mkSVG('g');
            grp.classList.add('ont-node-grp');
            grp.dataset.nodeIdx  = String(i);
            grp.style.cursor     = 'pointer';
            grp.style.transition = 'opacity 0.25s ease';

            const glowRing = this._mkSVG('circle', { r: R + 9, fill: 'none', stroke: node.color, 'stroke-width': '1.5', opacity: '0.15' });
            const shadow   = this._mkSVG('circle', { r: R + 2, cx: 2, cy: 4 });
            shadow.setAttribute('fill', 'rgba(0,0,0,0.18)');
            shadow.setAttribute('filter', 'url(#ont-shadow)');
            const circle = this._mkSVG('circle', { r: R, fill: `url(#${gid})`, stroke: node.color, 'stroke-width': '2.5' });
            node._circle = circle;

            if (!node._isReport) {
                const expandDot = this._mkSVG('circle', { r: '5', cy: R - 2, fill: 'white', stroke: node.color, 'stroke-width': '1.2', opacity: '0.8' });
                node._expandDot = expandDot;
            }

            const initText = this._mkSVG('text', {
                'text-anchor': 'middle', 'dominant-baseline': 'central',
                'font-size': Math.round(R * 0.5),
                fill: 'rgba(255,255,255,0.95)', 'pointer-events': 'none',
                'font-weight': '700', 'font-family': 'system-ui,-apple-system,sans-serif',
                y: node._isReport ? -5 : (node.measures.length > 0 ? -5 : 0)
            });
            initText.textContent = node.initials;

            if (node._isReport) {
                const vcText = this._mkSVG('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': '8', fill: 'rgba(255,255,255,0.65)', 'pointer-events': 'none', 'font-family': 'Consolas,monospace', y: R * 0.46 });
                vcText.textContent = `${node._visualCount || 0}v`;
                grp.appendChild(vcText);
            } else if (node.measures.length > 0) {
                const mcText = this._mkSVG('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': '9', fill: 'rgba(255,255,255,0.7)', 'pointer-events': 'none', 'font-family': 'Consolas,monospace', y: R * 0.44 });
                mcText.textContent = `Σ ${node.measures.length}`;
                grp.appendChild(mcText);
            }

            const label = this._mkSVG('text', {
                'text-anchor': 'middle', 'dominant-baseline': 'hanging',
                'font-size': '12', 'font-weight': '600',
                fill: 'var(--text, #1e293b)', 'pointer-events': 'none',
                'font-family': 'system-ui,-apple-system,sans-serif', y: R + 8
            });
            label.textContent = node.name.length > 22 ? node.name.slice(0, 20) + '…' : node.name;

            const BADGES = { fieldparam: 'FIELD PARAM', calcgroup: 'CALC GROUP', hidden: 'HIDDEN', report: 'PAGE' };
            if (BADGES[node.typeKey]) {
                const badge = this._mkSVG('text', { 'text-anchor': 'middle', 'dominant-baseline': 'hanging', 'font-size': '9', 'font-weight': '700', fill: node.color, 'pointer-events': 'none', y: R + 23 });
                badge.textContent = BADGES[node.typeKey];
                grp.appendChild(badge);
            }

            grp.appendChild(glowRing);
            grp.appendChild(shadow);
            grp.appendChild(circle);
            if (node._expandDot) grp.appendChild(node._expandDot);
            grp.appendChild(initText);
            grp.appendChild(label);

            // Hover: highlight connected neighbourhood
            grp.addEventListener('mouseenter', () => {
                if (!node._selected) { circle.setAttribute('stroke-width', '4'); glowRing.setAttribute('opacity', '0.35'); }
                this._setHighlight(i);
            });
            grp.addEventListener('mouseleave', () => {
                if (!node._selected) { circle.setAttribute('stroke-width', '2.5'); glowRing.setAttribute('opacity', '0.15'); }
                this._clearHighlight();
            });

            grp.addEventListener('click', e => {
                e.stopPropagation();
                if (!node._isReport) this._toggleExpand(i, container);
                this._selectNode(i, container);
            });

            // Drag via D3 fx/fy pinning
            grp.addEventListener('mousedown', e => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();
                this._dragging = { idx: i, node };
                node.fx = node.x; node.fy = node.y;
                if (this._simulation) this._simulation.alphaTarget(0.3).restart();
                if (this._svgEl) this._svgEl.style.cursor = 'grabbing';
            });

            nodeLayer.appendChild(grp);
            node._grp = grp;
        });
    }

    _createEdgeElements(edgeLayer) {
        this._edges.forEach(edge => {
            const grp = this._mkSVG('g');
            let path;
            if (edge._isReportEdge) {
                // Long dashes — external report linkage
                path = this._mkSVG('path', { fill: 'none', stroke: '#0ea5e9',
                    'stroke-width': '1.2', opacity: '0.45', 'stroke-dasharray': '10,5' });
            } else {
                // Solid — primary structural model relationship
                path = this._mkSVG('path', { fill: 'none', stroke: '#94a3b8',
                    'stroke-width': '2', opacity: '0.6', 'marker-end': 'url(#ont-arrow)' });
            }
            grp.appendChild(path);
            edge._path = path;

            if (!edge._isReportEdge) {
                const lbl = this._mkSVG('text', { 'font-size': '10', fill: '#94a3b8', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'pointer-events': 'none', 'font-family': 'system-ui,sans-serif' });
                lbl.textContent = edge.card;
                grp.appendChild(lbl);
                edge._label = lbl;
            }
            edgeLayer.appendChild(grp);
        });
    }

    // ─── Interaction ─────────────────────────────────────────────────────────

    _initInteraction(svg, container) {
        let isPanning = false;
        let panStart  = { x: 0, y: 0 };

        svg.addEventListener('wheel', e => {
            e.preventDefault();
            const f = e.deltaY > 0 ? 0.87 : 1.15;
            this._scale = Math.max(0.1, Math.min(4.5, this._scale * f));
            this._applyRootTransform();
        }, { passive: false });

        svg.addEventListener('mousedown', e => {
            if (e.button === 0 && !this._dragging) {
                isPanning = true;
                panStart  = { x: e.clientX - this._tx, y: e.clientY - this._ty };
                svg.style.cursor = 'grabbing';
            }
        });

        const onMove = e => {
            if (this._dragging) {
                const rect = svg.getBoundingClientRect();
                const mx = (e.clientX - rect.left  - this._W / 2 - this._tx) / this._scale;
                const my = (e.clientY - rect.top   - this._H / 2 - this._ty) / this._scale;
                this._dragging.node.fx = mx;
                this._dragging.node.fy = my;
            } else if (isPanning) {
                this._tx = e.clientX - panStart.x;
                this._ty = e.clientY - panStart.y;
                this._applyRootTransform();
            }
        };

        const onUp = () => {
            if (this._dragging) {
                this._dragging.node.fx = null;
                this._dragging.node.fy = null;
                if (this._simulation) this._simulation.alphaTarget(0);
                this._dragging = null;
            }
            isPanning = false;
            if (svg) svg.style.cursor = 'grab';
        };

        this._onMouseMove = onMove;
        this._onMouseUp   = onUp;
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup',   onUp);

        const zIn    = container.querySelector('[data-ontology-zoom="in"]');
        const zOut   = container.querySelector('[data-ontology-zoom="out"]');
        const zReset = container.querySelector('[data-ontology-zoom="reset"]');
        if (zIn)    zIn.addEventListener('click',    () => { this._scale = Math.min(4.5, this._scale * 1.3); this._applyRootTransform(); });
        if (zOut)   zOut.addEventListener('click',   () => { this._scale = Math.max(0.1,  this._scale / 1.3); this._applyRootTransform(); });
        if (zReset) zReset.addEventListener('click', () => { this._scale = 1; this._tx = 0; this._ty = 0; this._applyRootTransform(); });

        svg.addEventListener('click', () => this._deselectAll(container));
    }

    // ─── Hover highlighting ───────────────────────────────────────────────────

    _setHighlight(nodeIdx) {
        this._highlightSet = new Set([nodeIdx]);
        this._edges.forEach(e => {
            if (e.from === nodeIdx) this._highlightSet.add(e.to);
            if (e.to   === nodeIdx) this._highlightSet.add(e.from);
        });

        this._nodes.forEach((n, i) => {
            if (!n._grp || n._grp.style.display === 'none') return;
            n._grp.style.opacity = this._highlightSet.has(i) ? '1' : '0.15';
        });
        this._edges.forEach(e => {
            if (!e._path || e._path.style.display === 'none') return;
            const isConn = e.from === nodeIdx || e.to === nodeIdx;
            e._path.style.opacity  = isConn ? '0.92' : '0.05';
            if (e._label) e._label.style.opacity = isConn ? '1' : '0.05';
        });
    }

    _clearHighlight() {
        this._highlightSet = null;
        this._nodes.forEach(n => { if (n._grp) n._grp.style.opacity = ''; });
        this._edges.forEach(e => {
            if (e._path)  e._path.style.opacity  = '';
            if (e._label) e._label.style.opacity = '';
        });
    }

    // ─── DOM updates ─────────────────────────────────────────────────────────

    _updateDOM() {
        this._nodes.forEach(node => {
            if (!this._nodeActive(node) || !node._grp) return;
            node._grp.setAttribute('transform', `translate(${node.x.toFixed(1)},${node.y.toFixed(1)})`);

            if (node.expanded) {
                node.satellites.forEach(sat => {
                    if (!sat._grp) return;
                    const sx = node.x + Math.cos(sat.angle) * sat.orbitR;
                    const sy = node.y + Math.sin(sat.angle) * sat.orbitR;
                    sat.x = sx; sat.y = sy;
                    sat._grp.setAttribute('transform', `translate(${sx.toFixed(1)},${sy.toFixed(1)})`);
                    if (sat._spoke) {
                        const dx = sx - node.x, dy = sy - node.y;
                        const d  = Math.sqrt(dx * dx + dy * dy) + 0.001;
                        sat._spoke.setAttribute('x1', (node.x + dx / d * (node.radius + 3)).toFixed(1));
                        sat._spoke.setAttribute('y1', (node.y + dy / d * (node.radius + 3)).toFixed(1));
                        sat._spoke.setAttribute('x2', (sx - dx / d * sat.radius).toFixed(1));
                        sat._spoke.setAttribute('y2', (sy - dy / d * sat.radius).toFixed(1));
                    }
                });

                // Bundled measure trunk+branches: one shared path from the table
                // center toward the centroid of all visible measure satellites,
                // then individual branches fan out from that junction point.
                this._updateMsrTrunk(node);
            } else if (node._msrTrunkEl) {
                node._msrTrunkEl.style.display = 'none';
            }
        });

        this._updateColEdges();
        this._updateEdgePaths();
    }

    // Edge paths — relationship edges arc outward (never through inner rings).
    // Report edges aim directly at the target satellite when expanded.
    _updateEdgePaths() {
        this._edges.forEach(edge => {
            if (!edge._path) return;
            const a = this._nodes[edge.from];
            const b = this._nodes[edge.to];

            if (edge._isReportEdge) {
                // Aim at the specific satellite when the target table is expanded
                let tx = b.x, ty = b.y, endR = b.radius + 5;
                if (edge._reportField && b.expanded) {
                    const sat = b.satellites.find(s =>
                        s.name === edge._reportField && s._grp && s._grp.style.display !== 'none');
                    if (sat) { tx = sat.x; ty = sat.y; endR = sat.radius + 3; }
                }
                const ddx = tx - a.x, ddy = ty - a.y;
                const dd  = Math.sqrt(ddx * ddx + ddy * ddy) + 0.001;
                const sx  = a.x + ddx / dd * (a.radius + 3);
                const sy  = a.y + ddy / dd * (a.radius + 3);
                const ex  = tx  - ddx / dd * endR;
                const ey  = ty  - ddy / dd * endR;
                // Cubic bezier: CP1 leans away from source, CP2 leans away from target
                // so the arc bulges outward and never dips through inner layers
                const cp1x = sx - ddy / dd * 18 + ddx / dd * 12;
                const cp1y = sy + ddx / dd * 18 + ddy / dd * 12;
                const cp2x = ex - ddy / dd * 18 - ddx / dd * 12;
                const cp2y = ey + ddx / dd * 18 - ddy / dd * 12;
                edge._path.setAttribute('d',
                    `M${sx.toFixed(1)},${sy.toFixed(1)} C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`);
                return;
            }

            // Relationship edge (table ↔ table): arc outward with perpendicular offset.
            // Control point is pushed away from the midpoint — never toward center.
            const dx = b.x - a.x, dy = b.y - a.y;
            const d  = Math.sqrt(dx * dx + dy * dy) + 0.001;
            const sx = a.x + dx / d * (a.radius + 4);
            const sy = a.y + dy / d * (a.radius + 4);
            const ex = b.x - dx / d * (b.radius + 14);
            const ey = b.y - dy / d * (b.radius + 14);
            const mx = (sx + ex) / 2;
            const my = (sy + ey) / 2;
            // Pure perpendicular offset — bulges outward, stays clear of all layers
            const bx = mx - (dy / d) * 30;
            const by = my + (dx / d) * 30;

            edge._path.setAttribute('d',
                `M${sx.toFixed(1)},${sy.toFixed(1)} Q${bx.toFixed(1)},${by.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`);
            if (edge._label) {
                edge._label.setAttribute('x', bx.toFixed(1));
                edge._label.setAttribute('y', (by - 9).toFixed(1));
            }
        });
    }

    // Builds / updates the single bundled trunk+branch path for a table's measures.
    // One trunk goes from the table edge toward the centroid of all visible measure
    // satellites; from that junction each branch fans out to its individual measure.
    _updateMsrTrunk(node) {
        const msrSats = node.satellites.filter(s =>
            s.type === 'measure' && s._grp && s._grp.style.display !== 'none');

        if (msrSats.length === 0) {
            if (node._msrTrunkEl) node._msrTrunkEl.style.display = 'none';
            return;
        }

        if (!node._msrTrunkEl) {
            // Dash-dot — bundled measure trunk+branches
            node._msrTrunkEl = this._mkSVG('path', {
                fill: 'none', stroke: node.color,
                'stroke-width': '1.2', 'stroke-dasharray': '6,3,2,3',
                opacity: '0.45', 'pointer-events': 'none'
            });
            this._spokesLayer.appendChild(node._msrTrunkEl);
        }
        node._msrTrunkEl.style.display = '';

        // Junction = centroid of all visible measure positions
        let jx = 0, jy = 0;
        msrSats.forEach(s => { jx += s.x; jy += s.y; });
        jx /= msrSats.length;
        jy /= msrSats.length;

        // Trunk start: table-node edge facing the junction
        const tdx = jx - node.x, tdy = jy - node.y;
        const td  = Math.sqrt(tdx * tdx + tdy * tdy) + 0.001;
        const tsx = node.x + tdx / td * (node.radius + 3);
        const tsy = node.y + tdy / td * (node.radius + 3);

        // Single path: M table-edge → L junction, then branches
        let d = `M${tsx.toFixed(1)},${tsy.toFixed(1)} L${jx.toFixed(1)},${jy.toFixed(1)}`;

        msrSats.forEach(mSat => {
            const bdx = mSat.x - jx, bdy = mSat.y - jy;
            const bd  = Math.sqrt(bdx * bdx + bdy * bdy) + 0.001;
            // Branch endpoint: edge of the measure circle facing back to junction
            const bex = mSat.x - bdx / bd * mSat.radius;
            const bey = mSat.y - bdy / bd * mSat.radius;
            d += ` M${jx.toFixed(1)},${jy.toFixed(1)} L${bex.toFixed(1)},${bey.toFixed(1)}`;
        });

        node._msrTrunkEl.setAttribute('d', d);
    }

    // Arc edges from column (inner ring) to measure (outer ring) satellites.
    // Control points are placed OUTSIDE the outer ring so arcs never dip
    // back through the inner ring or the table node layer.
    _updateColEdges() {
        if (!this._colEdgesLayer || !this._colEdgeMap) return;

        const colLookup = new Map();
        this._nodes.forEach(node => {
            if (!node.expanded) return;
            node.satellites.forEach(sat => {
                if (sat.type === 'column' && sat._grp && sat._grp.style.display !== 'none') {
                    colLookup.set(`${node.name}::${sat.name}`, sat);
                }
            });
        });

        const colToMsrs = new Map();
        this._nodes.forEach(node => {
            if (!node.expanded) return;
            node.satellites.forEach(mSat => {
                if (mSat.type !== 'measure' || !mSat.colRefs) return;
                mSat.colRefs.forEach(ref => {
                    if (ref.tableName !== node.name) return;
                    const colKey = `${ref.tableName}::${ref.colName}`;
                    if (!colLookup.has(colKey)) return;
                    if (!colToMsrs.has(colKey)) colToMsrs.set(colKey, { msrList: [], node });
                    colToMsrs.get(colKey).msrList.push(mSat);
                });
            });
        });

        const active = new Set(colToMsrs.keys());

        const shortMid = (a, b) => {
            let d = b - a;
            if (d >  Math.PI) d -= 2 * Math.PI;
            if (d < -Math.PI) d += 2 * Math.PI;
            return a + d * 0.5;
        };
        const ep = (nx, ny, tx, ty, r) => {
            const dx = tx - nx, dy = ty - ny;
            const d  = Math.sqrt(dx * dx + dy * dy) + 0.001;
            return [nx + dx / d * r, ny + dy / d * r];
        };

        colToMsrs.forEach(({ msrList, node: pNode }, colKey) => {
            const colSat = colLookup.get(colKey);
            if (!colSat) return;

            let path = this._colEdgeMap.get(colKey);
            if (!path) {
                // Short dashes — DAX column→measure dependency arc
                path = this._mkSVG('path', { fill: 'none', stroke: '#a78bfa', 'stroke-width': '1.6', 'stroke-dasharray': '5,2', opacity: '0.75', 'pointer-events': 'none' });
                this._colEdgesLayer.appendChild(path);
                this._colEdgeMap.set(colKey, path);
            }
            path.style.display = '';

            const innerR   = colSat.orbitR;
            const outerR   = msrList[0].orbitR;
            const gap      = outerR - innerR;
            const colAngle = Math.atan2(colSat.y - pNode.y, colSat.x - pNode.x);
            // archR: control points placed OUTSIDE the outer ring
            const archR    = outerR + gap * 0.55;

            if (msrList.length === 1) {
                const mSat     = msrList[0];
                const msrAngle = Math.atan2(mSat.y - pNode.y, mSat.x - pNode.x);

                // Distribute the two cubic bezier CPs evenly along the short arc
                // at archR so the curve sweeps outside both rings.
                let delta = msrAngle - colAngle;
                if (delta >  Math.PI) delta -= 2 * Math.PI;
                if (delta < -Math.PI) delta += 2 * Math.PI;
                const cp1Angle = colAngle + delta * 0.25;
                const cp2Angle = colAngle + delta * 0.75;
                const cp1x = pNode.x + Math.cos(cp1Angle) * archR;
                const cp1y = pNode.y + Math.sin(cp1Angle) * archR;
                const cp2x = pNode.x + Math.cos(cp2Angle) * archR;
                const cp2y = pNode.y + Math.sin(cp2Angle) * archR;
                const [x1, y1] = ep(colSat.x, colSat.y, cp1x, cp1y, colSat.radius);
                const [x2, y2] = ep(mSat.x,   mSat.y,   cp2x, cp2y, mSat.radius);
                path.setAttribute('d',
                    `M${x1.toFixed(1)},${y1.toFixed(1)} C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`);

            } else {
                // Shared junction placed OUTSIDE outer ring at average measure direction
                let avgDx = 0, avgDy = 0;
                msrList.forEach(m => { avgDx += m.x - pNode.x; avgDy += m.y - pNode.y; });
                avgDx /= msrList.length; avgDy /= msrList.length;
                const jAngle = Math.atan2(avgDy, avgDx);
                const jR     = outerR + gap * 0.40;   // outside outer ring
                const jx     = pNode.x + Math.cos(jAngle) * jR;
                const jy     = pNode.y + Math.sin(jAngle) * jR;

                // Trunk: col → junction; CP also outside outer ring
                const ma_t = shortMid(colAngle, jAngle);
                const tcpR = outerR + gap * 0.20;
                const tcpx = pNode.x + Math.cos(ma_t) * tcpR;
                const tcpy = pNode.y + Math.sin(ma_t) * tcpR;
                const [tx1, ty1] = ep(colSat.x, colSat.y, tcpx, tcpy, colSat.radius);
                let d = `M${tx1.toFixed(1)},${ty1.toFixed(1)} Q${tcpx.toFixed(1)},${tcpy.toFixed(1)} ${jx.toFixed(1)},${jy.toFixed(1)}`;

                msrList.forEach(mSat => {
                    const msrAngle  = Math.atan2(mSat.y - pNode.y, mSat.x - pNode.x);
                    const ma_b      = shortMid(jAngle, msrAngle);
                    const bcpR      = outerR + gap * 0.50;   // outside outer ring
                    const bcpx      = pNode.x + Math.cos(ma_b) * bcpR;
                    const bcpy      = pNode.y + Math.sin(ma_b) * bcpR;
                    const [bx2, by2] = ep(mSat.x, mSat.y, bcpx, bcpy, mSat.radius);
                    d += ` M${jx.toFixed(1)},${jy.toFixed(1)} Q${bcpx.toFixed(1)},${bcpy.toFixed(1)} ${bx2.toFixed(1)},${by2.toFixed(1)}`;
                });
                path.setAttribute('d', d);
            }
        });

        this._colEdgeMap.forEach((path, key) => {
            if (!active.has(key)) path.style.display = 'none';
        });
    }

    // ─── Visibility helpers ───────────────────────────────────────────────────

    _nodeActive(n) {
        if (!this._showHidden  && n._hideNode)  return false;
        if (!this._showReports && n._isReport)  return false;
        return true;
    }

    _nodeVisible(n) {
        if (!this._nodeActive(n)) return false;
        if (this._reportFilter && !n._usedInReports && !n._isReport) return false;
        return true;
    }

    _satVisible(parentNode, sat) {
        if (!this._reportFilter) return true;
        if (sat.type === 'more-cols' || sat.type === 'more-msrs') return true;
        return this._reportUsedSet.has(`${parentNode.name}::${sat.name}`);
    }

    _applyNodeVisibility() {
        this._nodes.forEach(n => {
            const vis = this._nodeVisible(n);
            if (n._grp) n._grp.style.display = vis ? '' : 'none';
            if (!vis && n.expanded) {
                n.expanded = false;
                n.satellites.forEach(sat => {
                    if (sat._grp)   sat._grp.style.display   = 'none';
                    if (sat._spoke) sat._spoke.style.display = 'none';
                });
                if (n._expandDot) n._expandDot.setAttribute('fill', 'white');
                if (n._msrTrunkEl) n._msrTrunkEl.style.display = 'none';
            } else if (vis && n.expanded) {
                n.satellites.forEach(sat => {
                    if (!sat._grp) return;
                    const satVis = this._satVisible(n, sat);
                    sat._grp.style.display   = satVis ? '' : 'none';
                    if (sat._spoke) sat._spoke.style.display = satVis ? '' : 'none';
                });
                // Re-evaluate trunk visibility — it depends on visible measure count
                this._updateMsrTrunk(n);
            }
        });
        this._edges.forEach(e => {
            const a = this._nodes[e.from], b = this._nodes[e.to];
            let vis = this._nodeVisible(a) && this._nodeVisible(b);
            if (vis && e._isReportEdge && e._reportField) {
                vis = this._reportUsedSet.size === 0 ||
                      !this._reportFilter ||
                      this._reportUsedSet.has(`${b.name}::${e._reportField}`);
            }
            if (e._path)  e._path.style.display  = vis ? '' : 'none';
            if (e._label) e._label.style.display  = (vis && e.card) ? '' : 'none';
        });
    }

    _setHiddenVisibility(show) {
        this._showHidden = show;
        if (show) {
            this._nodes.forEach(n => {
                if (!n._hideNode) return;
                n.x = (Math.random() - 0.5) * 150;
                n.y = (Math.random() - 0.5) * 150;
            });
            this._reheatSimulation(0.6);
        }
        this._applyNodeVisibility();
    }

    _setReportVisibility(show) {
        this._showReports = show;
        if (show) {
            this._nodes.forEach(n => {
                if (!n._isReport) return;
                let cx = 0, cy = 0, cnt = 0;
                this._edges.forEach(e => {
                    if (!e._isReportEdge) return;
                    const other = e.from === n._idx ? this._nodes[e.to]
                                : e.to   === n._idx ? this._nodes[e.from] : null;
                    if (other && !other._isReport) { cx += other.x; cy += other.y; cnt++; }
                });
                n.x = cnt > 0 ? cx / cnt + (Math.random() - 0.5) * 200 : (Math.random() - 0.5) * 400;
                n.y = cnt > 0 ? cy / cnt + (Math.random() - 0.5) * 200 : (Math.random() - 0.5) * 400;
            });
            this._reheatSimulation(0.7);
        }
        this._applyNodeVisibility();
    }

    _setReportFilter(enabled) {
        this._reportFilter = enabled;
        if (enabled) this._reheatSimulation(0.4);
        this._applyNodeVisibility();
    }

    // ─── Selection & detail panel ─────────────────────────────────────────────

    _selectNode(nodeIdx, container) {
        this._nodes.forEach((n, i) => {
            n._selected = (i === nodeIdx);
            if (!n._circle) return;
            if (i === nodeIdx) {
                n._circle.setAttribute('stroke-width', '4');
                n._circle.setAttribute('stroke', '#fbbf24');
                n._circle.setAttribute('filter', 'url(#ont-glow)');
            } else {
                n._circle.setAttribute('stroke-width', '2.5');
                n._circle.setAttribute('stroke', n.color);
                n._circle.removeAttribute('filter');
            }
        });
        const panel = container.querySelector('#ontologyDetailPanel');
        if (panel) {
            panel.style.display = 'block';
            const n = this._nodes[nodeIdx];
            if (n._isReport) this._renderReportDetail(panel, n);
            else             this._renderTableDetail(panel, n);
        }
    }

    _selectSatellite(parentNode, sat, container) {
        const panel = container.querySelector('#ontologyDetailPanel');
        if (!panel) return;
        panel.style.display = 'block';
        if (sat.type === 'measure') this._renderMeasureDetail(panel, parentNode, sat);
        else                        this._renderColumnDetail(panel, parentNode, sat);
    }

    _deselectAll(container) {
        this._nodes.forEach(n => {
            n._selected = false;
            if (!n._circle) return;
            n._circle.setAttribute('stroke-width', '2.5');
            n._circle.setAttribute('stroke', n.color);
            n._circle.removeAttribute('filter');
        });
        const panel = container.querySelector('#ontologyDetailPanel');
        if (panel) panel.style.display = 'none';
    }

    _renderTableDetail(panel, node) {
        const t    = node.table;
        const rels = (this.model.relationships || []).filter(r => r.fromTable === t.name || r.toTable === t.name);
        const esc  = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const TYPE_NAMES = { entity: 'Entity', fieldparam: 'Field Parameter', calcgroup: 'Calculation Group', hidden: 'Hidden Table' };
        panel.innerHTML = `
            <div class="ont-detail-header" style="border-left:4px solid ${node.color}">
                <div class="ont-detail-title-row">
                    <div>
                        <div class="ont-detail-type" style="color:${node.color}">${TYPE_NAMES[node.typeKey] || 'Entity'}</div>
                        <h3 class="ont-detail-name">${esc(node.name)}</h3>
                    </div>
                    <button class="ont-close-btn" onclick="this.closest('.ontology-detail').style.display='none'">×</button>
                </div>
                ${t.description ? `<p class="ont-desc">${esc(t.description)}</p>` : ''}
            </div>
            <div class="ont-stats-grid">
                <div class="ont-stat-cell"><div class="ont-stat-val">${node.cols.length}</div><div class="ont-stat-key">Columns</div></div>
                <div class="ont-stat-cell"><div class="ont-stat-val">${node.measures.length}</div><div class="ont-stat-key">Measures</div></div>
                <div class="ont-stat-cell"><div class="ont-stat-val">${rels.length}</div><div class="ont-stat-key">Relations</div></div>
                <div class="ont-stat-cell"><div class="ont-stat-val">${node.hiddenCols?.length || 0}</div><div class="ont-stat-key">Hidden</div></div>
            </div>
            ${rels.length > 0 ? `
            <div class="ont-section">
                <div class="ont-section-label">Relationships</div>
                <ul class="ont-prop-list">
                    ${rels.slice(0, 10).map(r => {
                        const other = r.fromTable === t.name ? r.toTable : r.fromTable;
                        const dir   = r.fromTable === t.name ? '→' : '←';
                        const c1    = r.fromCardinality === 'Many' ? '*' : '1';
                        const c2    = r.toCardinality   === 'Many' ? '*' : '1';
                        return `<li><span class="ont-rel-dir">${dir}</span><span class="ont-prop-name">${esc(other)}</span><span class="ont-dtype">${c1}:${c2}</span></li>`;
                    }).join('')}
                </ul>
            </div>` : ''}
            <div class="ont-section" style="padding:10px 14px">
                <div style="font-size:11px;color:var(--text-secondary)">
                    ${node.expanded ? '↙ Click node again to collapse' : '↗ Click node to expand columns &amp; measures'}
                </div>
            </div>
        `;
    }

    _renderMeasureDetail(panel, parentNode, sat) {
        const m   = sat.measure;
        const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        panel.innerHTML = `
            <div class="ont-detail-header" style="border-left:4px solid #7c3aed">
                <div class="ont-detail-title-row">
                    <div>
                        <div class="ont-detail-type" style="color:#7c3aed">KPI / Measure</div>
                        <h3 class="ont-detail-name">Σ ${esc(m.name)}</h3>
                    </div>
                    <button class="ont-close-btn" onclick="this.closest('.ontology-detail').style.display='none'">×</button>
                </div>
                <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">in <strong>${esc(parentNode.name)}</strong></div>
            </div>
            <div style="padding:10px 14px 6px">
                ${m.formatString  ? `<div class="ont-stat-row"><span>Format</span><strong>${esc(m.formatString)}</strong></div>` : ''}
                ${m.displayFolder ? `<div class="ont-stat-row"><span>Folder</span><strong>${esc(m.displayFolder)}</strong></div>` : ''}
                ${m.description   ? `<p class="ont-desc" style="padding:4px 0">${esc(m.description)}</p>` : ''}
            </div>
            ${m.expression ? `
            <div class="ont-section">
                <div class="ont-section-label">DAX Expression</div>
                <pre class="ont-dax-block">${esc(m.expression)}</pre>
            </div>` : ''}
        `;
    }

    _renderReportDetail(panel, node) {
        const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const tablesUsed = [];
        this._edges.forEach(e => {
            if (!e._isReportEdge) return;
            if (e.from === node._idx) tablesUsed.push(this._nodes[e.to].name);
        });
        const uniqueTables = [...new Set(tablesUsed)];
        panel.innerHTML = `
            <div class="ont-detail-header" style="border-left:4px solid #0ea5e9">
                <div class="ont-detail-title-row">
                    <div>
                        <div class="ont-detail-type" style="color:#0ea5e9">Report Page</div>
                        <h3 class="ont-detail-name">${esc(node.name)}</h3>
                    </div>
                    <button class="ont-close-btn" onclick="this.closest('.ontology-detail').style.display='none'">×</button>
                </div>
            </div>
            <div class="ont-stats-grid">
                <div class="ont-stat-cell"><div class="ont-stat-val">${node._visualCount || 0}</div><div class="ont-stat-key">Visuals</div></div>
                <div class="ont-stat-cell"><div class="ont-stat-val">${uniqueTables.length}</div><div class="ont-stat-key">Tables</div></div>
            </div>
            ${uniqueTables.length > 0 ? `
            <div class="ont-section">
                <div class="ont-section-label">Tables Referenced</div>
                <ul class="ont-prop-list">
                    ${uniqueTables.map(t => `<li><span class="ont-prop-name">${esc(t)}</span></li>`).join('')}
                </ul>
            </div>` : ''}
        `;
    }

    _renderColumnDetail(panel, parentNode, sat) {
        const c   = sat.col;
        const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        panel.innerHTML = `
            <div class="ont-detail-header" style="border-left:4px solid ${sat.color}">
                <div class="ont-detail-title-row">
                    <div>
                        <div class="ont-detail-type" style="color:${sat.color}">Property / Column</div>
                        <h3 class="ont-detail-name">${esc(c.name)}</h3>
                    </div>
                    <button class="ont-close-btn" onclick="this.closest('.ontology-detail').style.display='none'">×</button>
                </div>
                <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">in <strong>${esc(parentNode.name)}</strong></div>
            </div>
            <div style="padding:10px 14px 6px">
                <div class="ont-stat-row"><span>Data Type</span><strong>${esc(c.dataType || '–')}</strong></div>
                ${c.formatString  ? `<div class="ont-stat-row"><span>Format</span><strong>${esc(c.formatString)}</strong></div>` : ''}
                ${c.displayFolder ? `<div class="ont-stat-row"><span>Folder</span><strong>${esc(c.displayFolder)}</strong></div>` : ''}
                <div class="ont-stat-row"><span>Key column</span><strong>${c.isKey ? 'Yes' : 'No'}</strong></div>
                ${c.description   ? `<p class="ont-desc" style="padding:4px 0">${esc(c.description)}</p>` : ''}
            </div>
            ${c.expression ? `
            <div class="ont-section">
                <div class="ont-section-label">Calculated Column Expression</div>
                <pre class="ont-dax-block">${esc(c.expression)}</pre>
            </div>` : ''}
        `;
    }

    // ─── Legend ──────────────────────────────────────────────────────────────

    _addLegend(container) {
        const div = document.createElement('div');
        div.className = 'ont-legend';
        div.innerHTML = `
            <div class="ont-legend-title">Entity Types</div>
            ${[
                { color: '#2563eb', label: 'Entity',          r: 6 },
                { color: '#7c3aed', label: 'Field Parameter', r: 6 },
                { color: '#ea580c', label: 'Calc Group',      r: 6 },
                { color: '#64748b', label: 'Hidden',          r: 6 },
                { color: '#0ea5e9', label: 'Report Page',     r: 5 },
            ].map(it => `
                <div class="ont-legend-item">
                    <svg width="14" height="14" viewBox="0 0 14 14" style="flex-shrink:0"><circle cx="7" cy="7" r="${it.r}" fill="${it.color}"/></svg>
                    <span>${it.label}</span>
                </div>`).join('')}
            <div class="ont-legend-sep"></div>
            <div class="ont-legend-title">Properties</div>
            ${[
                { color: '#16a34a', label: 'Numeric' },
                { color: '#0891b2', label: 'Text' },
                { color: '#e11d48', label: 'DateTime' },
                { color: '#f59e0b', label: 'Boolean' },
            ].map(it => `
                <div class="ont-legend-item">
                    <svg width="10" height="10" viewBox="0 0 10 10" style="flex-shrink:0"><circle cx="5" cy="5" r="4" fill="${it.color}" opacity=".88"/></svg>
                    <span>${it.label}</span>
                </div>`).join('')}
            <div class="ont-legend-sep"></div>
            <div class="ont-legend-item">
                <svg width="16" height="16" viewBox="0 0 16 16" style="flex-shrink:0">
                    <circle cx="8" cy="8" r="7" fill="#5b21b6"/>
                    <text x="8" y="8" text-anchor="middle" dominant-baseline="central" fill="white" font-size="9" font-weight="700">Σ</text>
                </svg>
                <span>Measure / KPI</span>
            </div>
            <div class="ont-legend-sep"></div>
            <div class="ont-legend-title">Edge Types</div>
            ${[
                { dash: 'none',       color: '#94a3b8', label: 'Relationship',       w: 2   },
                { dash: '10,5',       color: '#0ea5e9', label: 'Report reference',   w: 1.2 },
                { dash: '2,4',        color: '#64748b', label: 'Column membership',  w: 1   },
                { dash: '6,3,2,3',    color: '#64748b', label: 'Measure group',      w: 1.2 },
                { dash: '5,2',        color: '#a78bfa', label: 'DAX dependency',     w: 1.6 },
            ].map(it => `
                <div class="ont-legend-item">
                    <svg width="26" height="10" viewBox="0 0 26 10" style="flex-shrink:0">
                        <line x1="2" y1="5" x2="24" y2="5" stroke="${it.color}"
                            stroke-width="${it.w}"
                            ${it.dash !== 'none' ? `stroke-dasharray="${it.dash}"` : ''}/>
                    </svg>
                    <span>${it.label}</span>
                </div>`).join('')}
            <div class="ont-legend-sep"></div>
            <div class="ont-legend-hint">Click to expand · Drag · Scroll to zoom · Hover to highlight</div>
        `;

        const hiddenCount = this._nodes.filter(n => n._hideNode).length;
        if (hiddenCount > 0) {
            const btn = document.createElement('button');
            btn.className = 'ont-hidden-toggle';
            btn.textContent = `Show hidden tables (${hiddenCount})`;
            btn.addEventListener('click', () => {
                const nowShow = !this._showHidden;
                this._setHiddenVisibility(nowShow);
                btn.textContent = nowShow ? `Hide hidden tables (${hiddenCount})` : `Show hidden tables (${hiddenCount})`;
                btn.classList.toggle('ont-hidden-toggle--active', nowShow);
            });
            div.appendChild(btn);
        }

        const reportCount = this._nodes.filter(n => n._isReport).length;
        if (reportCount > 0) {
            const rBtn = document.createElement('button');
            rBtn.className = 'ont-hidden-toggle';
            rBtn.textContent = this._showReports ? `Hide report pages (${reportCount})` : `Show report pages (${reportCount})`;
            rBtn.classList.toggle('ont-hidden-toggle--active', this._showReports);
            rBtn.addEventListener('click', () => {
                const nowShow = !this._showReports;
                this._setReportVisibility(nowShow);
                rBtn.textContent = nowShow ? `Hide report pages (${reportCount})` : `Show report pages (${reportCount})`;
                rBtn.classList.toggle('ont-hidden-toggle--active', nowShow);
            });
            div.appendChild(rBtn);

            const usedN  = this._nodes.filter(n => !n._isReport && n._usedInReports).length;
            const totalN = this._nodes.filter(n => !n._isReport && !n._hideNode).length;
            const fBtn = document.createElement('button');
            fBtn.className = 'ont-hidden-toggle';
            fBtn.textContent = this._reportFilter ? `Show all tables` : `Filter: report-used only (${usedN}/${totalN})`;
            fBtn.classList.toggle('ont-hidden-toggle--active', this._reportFilter);
            fBtn.addEventListener('click', () => {
                const nowFilter = !this._reportFilter;
                this._setReportFilter(nowFilter);
                fBtn.classList.toggle('ont-hidden-toggle--active', nowFilter);
                fBtn.textContent = nowFilter ? `Show all tables` : `Filter: report-used only (${usedN}/${totalN})`;
            });
            div.appendChild(fBtn);
        }

        container.appendChild(div);
    }

    // ─── Fabric IQ export ────────────────────────────────────────────────────

    exportFabricIQ() {
        const BASE_ENT  = 1000000000000;
        const BASE_PROP = 2000000000000;
        const BASE_REL  = 3000000000000;
        const model     = this.model;
        const tables    = (model.tables || []).filter(t => !t._isAutoDate);

        const entityTypes = tables.map((t, i) => {
            const props = [];
            let pIdx = 0;
            (t.columns || []).forEach(c => {
                props.push({ id: BASE_PROP + i * 1000 + pIdx++, name: c.name, dataType: this._mapDataType(c.dataType), isHidden: !!c.isHidden, isMeasure: false });
            });
            (t.measures || []).forEach(m => {
                props.push({ id: BASE_PROP + i * 1000 + pIdx++, name: m.name, dataType: 'Double', isHidden: !!m.isHidden, isMeasure: true, formatString: m.formatString || '', description: m.description || '' });
            });
            return { id: BASE_ENT + i, name: t.name, description: t.description || '', isHidden: !!t.isHidden, entityKind: t._isFieldParameter ? 'FieldParameter' : t._isCalcGroup ? 'CalculationGroup' : 'Regular', properties: props };
        });

        const entityIdx = {};
        tables.forEach((t, i) => { entityIdx[t.name] = BASE_ENT + i; });

        const relationshipTypes = (model.relationships || []).map((r, i) => ({
            id: BASE_REL + i,
            name: `${r.fromTable}_${r.fromColumn}_${r.toTable}_${r.toColumn}`,
            fromEntityId: entityIdx[r.fromTable], toEntityId: entityIdx[r.toTable],
            fromColumn: r.fromColumn, toColumn: r.toColumn,
            fromCardinality: r.fromCardinality || 'Many', toCardinality: r.toCardinality || 'One',
            isActive: r.isActive !== false,
            crossFilteringBehavior: r.crossFilteringBehavior || 'OneDirection'
        }));

        return {
            schemaVersion: '1.0', generatedWith: 'pbip-semlin-ontology',
            generatedAt: new Date().toISOString(), modelName: model.name || 'SemanticModel',
            entityTypes, relationshipTypes
        };
    }

    _mapDataType(dt) {
        const map = { int64: 'BigInt', int32: 'BigInt', integer: 'BigInt', double: 'Double', decimal: 'Double', currency: 'Double', single: 'Double', string: 'String', text: 'String', boolean: 'Boolean', datetime: 'DateTime', date: 'DateTime', time: 'DateTime' };
        return map[(dt || '').toLowerCase()] || 'String';
    }

    _mkSVG(tag, attrs = {}) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
        return el;
    }
}

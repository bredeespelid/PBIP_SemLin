'use strict';

class OntologyRenderer {
    constructor(model, lineageEngine, visualData, bpaResults) {
        this.model = model;
        this.lineageEngine = lineageEngine;
        this.visualData = visualData;
        this.bpaResults = bpaResults;
        this._nodes = [];
        this._edges = [];
        this._dragging = null;
        this._svg = null;
        this._root = null;
        this._spokesLayer = null;
        this._colEdgesLayer = null;
        this._satLayer = null;
        this._alpha = 1.0;
        this._running = false;
        this._animFrame = null;
        this._tx = 0;
        this._ty = 0;
        this._scale = 1;
        this._W = 900;
        this._H = 600;
        this._container = null;
        this._defs = null;
        this._showHidden = false;
    }

    destroy() {
        this._running = false;
        if (this._animFrame) {
            cancelAnimationFrame(this._animFrame);
            this._animFrame = null;
        }
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

        const W = container.clientWidth || 900;
        const H = container.clientHeight || 580;
        this._W = W;
        this._H = H;

        const n = nodes.length;
        const initR = Math.min(W, H) * 0.3;
        nodes.forEach((node, i) => {
            const angle = (2 * Math.PI * i / Math.max(n, 1)) - Math.PI / 2;
            node.x = Math.cos(angle) * initR + (Math.random() - 0.5) * 20;
            node.y = Math.sin(angle) * initR + (Math.random() - 0.5) * 20;
            node.vx = 0;
            node.vy = 0;
        });

        const svg = this._mkSVG('svg', { width: '100%', height: '100%' });
        svg.style.cursor = 'grab';
        this._svg = svg;

        this._addDefs(svg);

        const root = this._mkSVG('g', { id: 'ont-root' });
        svg.appendChild(root);
        this._root = root;

        // Layer order matters: edges → spokes → table nodes → satellites
        const edgeLayer = this._mkSVG('g', { id: 'ont-edges' });
        root.appendChild(edgeLayer);

        const spokesLayer = this._mkSVG('g', { id: 'ont-spokes' });
        root.appendChild(spokesLayer);
        this._spokesLayer = spokesLayer;

        // Measure→column reference edges (above spokes, below nodes)
        const colEdgesLayer = this._mkSVG('g', { id: 'ont-col-edges' });
        root.appendChild(colEdgesLayer);
        this._colEdgesLayer = colEdgesLayer;
        this._colEdgeMap = new Map(); // key: "msrSat::colSat" → <line> element

        const nodeLayer = this._mkSVG('g', { id: 'ont-nodes' });
        root.appendChild(nodeLayer);

        const satLayer = this._mkSVG('g', { id: 'ont-satellites' });
        root.appendChild(satLayer);
        this._satLayer = satLayer;

        this._createEdgeElements(edgeLayer);
        this._createNodeElements(nodeLayer, container);
        // Default: hide hidden-table nodes immediately after DOM creation
        this._setHiddenVisibility(false);

        container.appendChild(svg);

        this._tx = 0;
        this._ty = 0;
        this._scale = 1;
        this._applyRootTransform();

        root.style.opacity = '0';
        root.style.transition = 'opacity 0.5s ease';
        requestAnimationFrame(() => { root.style.opacity = '1'; });

        this._initInteraction(svg, container);

        this._alpha = 1.0;
        this._running = true;
        this._tick();

        this._addLegend(container);

        const panel = document.createElement('div');
        panel.className = 'ontology-detail';
        panel.id = 'ontologyDetailPanel';
        panel.style.display = 'none';
        container.appendChild(panel);
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
                cols, hiddenCols, measures,
                initials,
                expanded: false,
                satellites: [],      // built lazily on first expand
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

        return { nodes, edges };
    }

    // Build satellite descriptors for a table node (called once, lazily)
    _buildSatellites(node) {
        const sats    = [];
        const INNER_R = node.radius + 55;   // columns
        const OUTER_R = node.radius + 108;  // measures

        const MAX_COLS = 14;
        const MAX_MSRS = 10;

        // Columns — key columns first, then alphabetical
        const cols = [...node.cols].sort((a, b) => {
            if (a.isKey && !b.isKey) return -1;
            if (!a.isKey && b.isKey) return 1;
            return a.name.localeCompare(b.name);
        });
        const showCols  = cols.slice(0, MAX_COLS);
        const extraCols = cols.length - showCols.length;
        const totalColSlots = showCols.length + (extraCols > 0 ? 1 : 0);

        showCols.forEach((c, i) => {
            sats.push({
                type: 'column', name: c.name, col: c,
                color: this._colTypeColor(c.dataType),
                radius: 11,
                orbitR: INNER_R,
                angle:  (2 * Math.PI * i / Math.max(totalColSlots, 1)) - Math.PI / 2,
                x: node.x, y: node.y, _grp: null, _spoke: null
            });
        });
        if (extraCols > 0) {
            sats.push({
                type: 'more-cols', name: `+${extraCols}`,
                color: '#94a3b8', radius: 11,
                orbitR: INNER_R,
                angle:  (2 * Math.PI * MAX_COLS / Math.max(totalColSlots, 1)) - Math.PI / 2,
                x: node.x, y: node.y, _grp: null, _spoke: null
            });
        }

        // Measures in outer ring
        const showMsrs  = node.measures.slice(0, MAX_MSRS);
        const extraMsrs = node.measures.length - showMsrs.length;
        const totalMsrSlots = showMsrs.length + (extraMsrs > 0 ? 1 : 0);

        showMsrs.forEach((m, i) => {
            sats.push({
                type: 'measure', name: m.name, measure: m,
                color: '#7c3aed',
                radius: 19,
                orbitR: OUTER_R,
                angle:  (2 * Math.PI * i / Math.max(totalMsrSlots, 1)) - Math.PI / 2,
                x: node.x, y: node.y, _grp: null, _spoke: null,
                colRefs: this._parseDaxColumnRefs(m.expression || '', node.name)
            });
        });
        if (extraMsrs > 0) {
            sats.push({
                type: 'more-msrs', name: `+${extraMsrs}`,
                color: '#7c3aed', radius: 13,
                orbitR: OUTER_R,
                angle:  (2 * Math.PI * MAX_MSRS / Math.max(totalMsrSlots, 1)) - Math.PI / 2,
                x: node.x, y: node.y, _grp: null, _spoke: null
            });
        }

        return sats;
    }

    _parseDaxColumnRefs(expr, defaultTable) {
        const refs = [];
        const seen = new Set();
        // Match explicit Table[Column] references
        const re = /(\w[\w\s]*?)\s*\[([^\]]+)\]/g;
        let m;
        while ((m = re.exec(expr)) !== null) {
            const tableName = m[1].trim();
            const colName   = m[2].trim();
            const key = `${tableName}::${colName}`;
            if (!seen.has(key)) { seen.add(key); refs.push({ tableName, colName }); }
        }
        // Match standalone [Column] (same table, after removing the above)
        const stripped = expr.replace(/\w[\w\s]*?\s*\[[^\]]+\]/g, '');
        const re2 = /\[([^\]]+)\]/g;
        while ((m = re2.exec(stripped)) !== null) {
            const colName = m[1].trim();
            const key = `${defaultTable}::${colName}`;
            if (!seen.has(key)) { seen.add(key); refs.push({ tableName: defaultTable, colName }); }
        }
        return refs;
    }

    _colTypeColor(dt) {
        const t = (dt || '').toLowerCase();
        if (['int64','int32','integer','double','decimal','currency','single'].includes(t)) return '#16a34a'; // green
        if (['string','text'].includes(t)) return '#0891b2';                                                 // cyan — distinct from entity blue
        if (['datetime','date','time'].includes(t)) return '#e11d48';                                        // rose-red — distinct from calc group orange
        if (['boolean'].includes(t)) return '#f59e0b';                                                       // amber — distinct from all above
        return '#94a3b8';
    }

    // ─── Expand / collapse ───────────────────────────────────────────────────

    _toggleExpand(nodeIdx, container) {
        const node = this._nodes[nodeIdx];
        node.expanded = !node.expanded;

        if (node.expanded) {
            if (node.satellites.length === 0) {
                node.satellites = this._buildSatellites(node);
            }
            node.satellites.forEach(sat => {
                if (!sat._grp) {
                    this._createSatelliteElement(sat, node, container);
                } else {
                    sat._grp.style.display  = '';
                    if (sat._spoke) sat._spoke.style.display = '';
                }
            });
            this._alpha = Math.max(this._alpha, 0.35); // re-energize so neighbours make room
        } else {
            node.satellites.forEach(sat => {
                if (sat._grp)  sat._grp.style.display  = 'none';
                if (sat._spoke) sat._spoke.style.display = 'none';
            });
        }

        // Update expand-dot indicator
        if (node._expandDot) {
            node._expandDot.setAttribute('fill', node.expanded ? node.color : 'white');
        }
    }

    _createSatelliteElement(sat, parentNode, container) {
        const R = sat.radius;

        // Spoke (dashed line from parent to satellite)
        const spoke = this._mkSVG('line', {
            stroke: parentNode.color, 'stroke-width': '1',
            'stroke-dasharray': '3,3', opacity: '0.35'
        });
        this._spokesLayer.appendChild(spoke);
        sat._spoke = spoke;

        const grp = this._mkSVG('g');
        grp.classList.add('ont-sat-grp');
        grp.style.cursor = sat.type.startsWith('more') ? 'default' : 'pointer';

        if (sat.type === 'column') {
            const circle = this._mkSVG('circle', {
                r: R, fill: sat.color, opacity: '0.88',
                stroke: 'white', 'stroke-width': '1.5'
            });
            // Hover tooltip
            const title = this._mkSVG('title');
            title.textContent = `${sat.name}  (${sat.col.dataType || '?'})`;
            grp.appendChild(circle);
            grp.appendChild(title);

        } else if (sat.type === 'measure') {
            const gid  = `sat-g-${Math.random().toString(36).slice(2)}`;
            const grad = this._mkSVG('radialGradient', { id: gid, cx: '38%', cy: '32%', r: '68%' });
            const s1   = this._mkSVG('stop', { offset: '0%' });
            s1.setAttribute('stop-color', '#c4b5fd');
            const s2 = this._mkSVG('stop', { offset: '100%' });
            s2.setAttribute('stop-color', '#5b21b6');
            grad.appendChild(s1); grad.appendChild(s2);
            this._defs.appendChild(grad);

            const circle = this._mkSVG('circle', {
                r: R, fill: `url(#${gid})`,
                stroke: '#7c3aed', 'stroke-width': '1.5'
            });
            const sym = this._mkSVG('text', {
                'text-anchor': 'middle', 'dominant-baseline': 'central',
                'font-size': '11', fill: 'white',
                'pointer-events': 'none', 'font-weight': '700'
            });
            sym.textContent = 'Σ';
            grp.appendChild(circle);
            grp.appendChild(sym);

            // Name label below measure node
            const lbl = this._mkSVG('text', {
                'text-anchor': 'middle', 'dominant-baseline': 'hanging',
                'font-size': '9', 'font-weight': '500',
                fill: 'var(--text, #1e293b)',
                'pointer-events': 'none', y: R + 4
            });
            lbl.textContent = sat.name.length > 14 ? sat.name.slice(0, 12) + '…' : sat.name;
            grp.appendChild(lbl);

        } else {
            // "+N more" placeholder
            const circle = this._mkSVG('circle', {
                r: R, fill: 'var(--surface,#fff)',
                stroke: sat.color, 'stroke-width': '1.5',
                'stroke-dasharray': '3,2', opacity: '0.8'
            });
            const txt = this._mkSVG('text', {
                'text-anchor': 'middle', 'dominant-baseline': 'central',
                'font-size': '8', fill: '#64748b',
                'pointer-events': 'none', 'font-weight': '700'
            });
            txt.textContent = sat.name;
            grp.appendChild(circle);
            grp.appendChild(txt);
        }

        // Click → detail panel
        if (!sat.type.startsWith('more')) {
            grp.addEventListener('click', e => {
                e.stopPropagation();
                this._selectSatellite(parentNode, sat, container);
            });
        }

        this._satLayer.appendChild(grp);
        sat._grp = grp;
    }

    // ─── Defs & node creation ────────────────────────────────────────────────

    _addDefs(svg) {
        const defs = this._mkSVG('defs');
        this._defs = defs;

        const mk = this._mkSVG('marker', {
            id: 'ont-arrow', markerWidth: '10', markerHeight: '7',
            refX: '9', refY: '3.5', orient: 'auto'
        });
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
            const s1   = this._mkSVG('stop', { offset: '0%' });
            s1.setAttribute('stop-color', node.light);
            const s2 = this._mkSVG('stop', { offset: '100%' });
            s2.setAttribute('stop-color', node.dark);
            grad.appendChild(s1); grad.appendChild(s2);
            this._defs.appendChild(grad);

            const grp = this._mkSVG('g');
            grp.classList.add('ont-node-grp');
            grp.dataset.nodeIdx = String(i);
            grp.style.cursor = 'pointer';

            const glowRing = this._mkSVG('circle', {
                r: R + 9, fill: 'none', stroke: node.color,
                'stroke-width': '1.5', opacity: '0.15'
            });
            const shadow = this._mkSVG('circle', { r: R + 2, cx: 2, cy: 4 });
            shadow.setAttribute('fill', 'rgba(0,0,0,0.18)');
            shadow.setAttribute('filter', 'url(#ont-shadow)');

            const circle = this._mkSVG('circle', {
                r: R, fill: `url(#${gid})`,
                stroke: node.color, 'stroke-width': '2.5'
            });
            node._circle = circle;

            // Small expand indicator dot at bottom of circle
            const expandDot = this._mkSVG('circle', {
                r: '5', cy: R - 2,
                fill: 'white', stroke: node.color, 'stroke-width': '1.2', opacity: '0.8'
            });
            node._expandDot = expandDot;

            const initText = this._mkSVG('text', {
                'text-anchor': 'middle', 'dominant-baseline': 'central',
                'font-size': Math.round(R * 0.5),
                fill: 'rgba(255,255,255,0.95)', 'pointer-events': 'none',
                'font-weight': '700', 'font-family': 'system-ui,-apple-system,sans-serif',
                y: node.measures.length > 0 ? -5 : 0
            });
            initText.textContent = node.initials;

            if (node.measures.length > 0) {
                const mcText = this._mkSVG('text', {
                    'text-anchor': 'middle', 'dominant-baseline': 'central',
                    'font-size': '9', fill: 'rgba(255,255,255,0.7)',
                    'pointer-events': 'none', 'font-family': 'Consolas,monospace',
                    y: R * 0.44
                });
                mcText.textContent = `Σ ${node.measures.length}`;
                grp.appendChild(mcText);
            }

            const label = this._mkSVG('text', {
                'text-anchor': 'middle', 'dominant-baseline': 'hanging',
                'font-size': '12', 'font-weight': '600',
                fill: 'var(--text, #1e293b)', 'pointer-events': 'none',
                'font-family': 'system-ui,-apple-system,sans-serif',
                y: R + 8
            });
            label.textContent = node.name.length > 22 ? node.name.slice(0, 20) + '…' : node.name;

            const BADGES = { fieldparam: 'FIELD PARAM', calcgroup: 'CALC GROUP', hidden: 'HIDDEN' };
            if (BADGES[node.typeKey]) {
                const badge = this._mkSVG('text', {
                    'text-anchor': 'middle', 'dominant-baseline': 'hanging',
                    'font-size': '9', 'font-weight': '700',
                    fill: node.color, 'pointer-events': 'none', y: R + 23
                });
                badge.textContent = BADGES[node.typeKey];
                grp.appendChild(badge);
            }

            grp.appendChild(glowRing);
            grp.appendChild(shadow);
            grp.appendChild(circle);
            grp.appendChild(expandDot);
            grp.appendChild(initText);
            grp.appendChild(label);

            grp.addEventListener('mouseenter', () => {
                if (!node._selected) {
                    circle.setAttribute('stroke-width', '4');
                    glowRing.setAttribute('opacity', '0.35');
                }
            });
            grp.addEventListener('mouseleave', () => {
                if (!node._selected) {
                    circle.setAttribute('stroke-width', '2.5');
                    glowRing.setAttribute('opacity', '0.15');
                }
            });

            grp.addEventListener('click', e => {
                e.stopPropagation();
                this._toggleExpand(i, container);
                this._selectNode(i, container);
            });

            grp.addEventListener('mousedown', e => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();
                this._dragging = { idx: i, node };
                node._pinned = true;
                if (this._svg) this._svg.style.cursor = 'grabbing';
            });

            nodeLayer.appendChild(grp);
            node._grp = grp;
        });
    }

    _createEdgeElements(edgeLayer) {
        this._edges.forEach(edge => {
            const grp = this._mkSVG('g');
            const path = this._mkSVG('path', {
                fill: 'none', stroke: '#94a3b8',
                'stroke-width': '1.5', opacity: '0.55',
                'marker-end': 'url(#ont-arrow)'
            });
            grp.appendChild(path);
            edge._path = path;

            const lbl = this._mkSVG('text', {
                'font-size': '10', fill: '#94a3b8',
                'text-anchor': 'middle', 'dominant-baseline': 'middle',
                'pointer-events': 'none', 'font-family': 'system-ui,sans-serif'
            });
            lbl.textContent = edge.card;
            grp.appendChild(lbl);
            edge._label = lbl;
            edgeLayer.appendChild(grp);
        });
    }

    // ─── Physics simulation ──────────────────────────────────────────────────

    _applyRootTransform() {
        if (!this._root) return;
        this._root.setAttribute('transform',
            `translate(${this._W / 2 + this._tx},${this._H / 2 + this._ty}) scale(${this._scale})`
        );
    }

    _tick() {
        if (!this._running) return;

        if (this._alpha > 0.003) {
            this._alpha *= 0.974;

            const REPK    = 11000;
            const SPRINGK = 0.032;
            const REST    = 260;
            const DAMP    = 0.80;
            const CENK    = 0.007;
            const nodes   = this._nodes;
            const edges   = this._edges;

            nodes.forEach(n => { n._fx = 0; n._fy = 0; });

            for (let i = 0; i < nodes.length; i++) {
                if (!this._showHidden && nodes[i]._hideNode) continue;
                for (let j = i + 1; j < nodes.length; j++) {
                    if (!this._showHidden && nodes[j]._hideNode) continue;
                    const a = nodes[i], b = nodes[j];
                    // Expanded nodes need more personal space
                    const ra = a.expanded ? a.radius + 160 : a.radius;
                    const rb = b.expanded ? b.radius + 160 : b.radius;
                    const dx = b.x - a.x, dy = b.y - a.y;
                    const d2 = dx * dx + dy * dy + 1;
                    const d  = Math.sqrt(d2);
                    const f  = d < ra + rb + 30 ? (REPK * 2.5) / d2 : REPK / d2;
                    const fx = f * dx / d, fy = f * dy / d;
                    a._fx -= fx; a._fy -= fy;
                    b._fx += fx; b._fy += fy;
                }
            }

            edges.forEach(e => {
                const a = nodes[e.from], b = nodes[e.to];
                if (!this._showHidden && (a._hideNode || b._hideNode)) return;
                const dx = b.x - a.x, dy = b.y - a.y;
                const d  = Math.sqrt(dx * dx + dy * dy) + 0.01;
                const f  = SPRINGK * (d - REST);
                const fx = f * dx / d, fy = f * dy / d;
                a._fx += fx; a._fy += fy;
                b._fx -= fx; b._fy -= fy;
            });

            nodes.forEach(n => {
                if (!this._showHidden && n._hideNode) return;
                n._fx -= CENK * n.x; n._fy -= CENK * n.y;
            });

            nodes.forEach(n => {
                if (n._pinned) return;
                if (!this._showHidden && n._hideNode) return;
                n.vx = (n.vx + n._fx) * DAMP;
                n.vy = (n.vy + n._fy) * DAMP;
                n.x += n.vx;
                n.y += n.vy;
            });
        }

        this._updateDOM();
        this._animFrame = requestAnimationFrame(() => this._tick());
    }

    _updateDOM() {
        this._nodes.forEach(node => {
            if (!this._showHidden && node._hideNode) return;
            if (node._grp) {
                node._grp.setAttribute('transform',
                    `translate(${node.x.toFixed(1)},${node.y.toFixed(1)})`);
            }

            // Satellites orbit their parent
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
                        sat._spoke.setAttribute('x2', (sx   - dx / d * sat.radius).toFixed(1));
                        sat._spoke.setAttribute('y2', (sy   - dy / d * sat.radius).toFixed(1));
                    }
                });
            }
        });

        this._updateColEdges();

        this._edges.forEach(edge => {
            if (!edge._path) return;
            const a  = this._nodes[edge.from];
            const b  = this._nodes[edge.to];
            const dx = b.x - a.x, dy = b.y - a.y;
            const d  = Math.sqrt(dx * dx + dy * dy) + 0.001;
            const sx = a.x + dx / d * (a.radius + 4);
            const sy = a.y + dy / d * (a.radius + 4);
            const ex = b.x - dx / d * (b.radius + 14);
            const ey = b.y - dy / d * (b.radius + 14);
            const cx = (sx + ex) / 2 - (dy / d) * 28;
            const cy = (sy + ey) / 2 + (dx / d) * 28;
            edge._path.setAttribute('d',
                `M${sx.toFixed(1)},${sy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`
            );
            if (edge._label) {
                edge._label.setAttribute('x', cx.toFixed(1));
                edge._label.setAttribute('y', (cy - 9).toFixed(1));
            }
        });
    }

    // Draw bundled edges from each visible column to all measure satellites that reference it
    _updateColEdges() {
        if (!this._colEdgesLayer || !this._colEdgeMap) return;

        // Build lookup: "tableName::colName" → colSat (only for expanded tables)
        const colLookup = new Map();
        this._nodes.forEach(node => {
            if (!node.expanded) return;
            node.satellites.forEach(sat => {
                if (sat.type === 'column' && sat._grp && sat._grp.style.display !== 'none') {
                    colLookup.set(`${node.name}::${sat.name}`, sat);
                }
            });
        });

        // Build per-column measure list: colKey → [mSat, ...]
        const colToMsrs = new Map();
        this._nodes.forEach(node => {
            if (!node.expanded) return;
            node.satellites.forEach(mSat => {
                if (mSat.type !== 'measure' || !mSat.colRefs) return;
                mSat.colRefs.forEach(ref => {
                    // Only draw intra-table edges; cross-table refs are covered by relationship arrows
                    if (ref.tableName !== node.name) return;
                    const colKey = `${ref.tableName}::${ref.colName}`;
                    if (!colLookup.has(colKey)) return;
                    if (!colToMsrs.has(colKey)) colToMsrs.set(colKey, []);
                    colToMsrs.get(colKey).push(mSat);
                });
            });
        });

        const active = new Set(colToMsrs.keys());

        colToMsrs.forEach((msrList, colKey) => {
            const colSat = colLookup.get(colKey);
            if (!colSat) return;

            let path = this._colEdgeMap.get(colKey);
            if (!path) {
                path = this._mkSVG('path', {
                    fill: 'none', stroke: '#a78bfa', 'stroke-width': '1.3',
                    'stroke-dasharray': '4,3', opacity: '0.65',
                    'pointer-events': 'none'
                });
                this._colEdgesLayer.appendChild(path);
                this._colEdgeMap.set(colKey, path);
            }
            path.style.display = '';

            if (msrList.length === 1) {
                // Single measure → straight line
                const mSat = msrList[0];
                const dx = mSat.x - colSat.x, dy = mSat.y - colSat.y;
                const d  = Math.sqrt(dx * dx + dy * dy) + 0.001;
                const x1 = (colSat.x + dx / d * colSat.radius).toFixed(1);
                const y1 = (colSat.y + dy / d * colSat.radius).toFixed(1);
                const x2 = (mSat.x  - dx / d * mSat.radius).toFixed(1);
                const y2 = (mSat.y  - dy / d * mSat.radius).toFixed(1);
                path.setAttribute('d', `M${x1},${y1} L${x2},${y2}`);
            } else {
                // Multiple measures → trunk + branches
                // Centroid of all measure positions
                let cx = 0, cy = 0;
                msrList.forEach(m => { cx += m.x; cy += m.y; });
                cx /= msrList.length; cy /= msrList.length;

                // Junction: 45% from column toward centroid
                const jx = colSat.x + (cx - colSat.x) * 0.45;
                const jy = colSat.y + (cy - colSat.y) * 0.45;

                // Trunk start at column edge
                const tdx = jx - colSat.x, tdy = jy - colSat.y;
                const td  = Math.sqrt(tdx * tdx + tdy * tdy) + 0.001;
                const tx1 = (colSat.x + tdx / td * colSat.radius).toFixed(1);
                const ty1 = (colSat.y + tdy / td * colSat.radius).toFixed(1);

                let d = `M${tx1},${ty1} L${jx.toFixed(1)},${jy.toFixed(1)}`;

                msrList.forEach(mSat => {
                    const bdx = mSat.x - jx, bdy = mSat.y - jy;
                    const bd  = Math.sqrt(bdx * bdx + bdy * bdy) + 0.001;
                    const bx2 = (mSat.x - bdx / bd * mSat.radius).toFixed(1);
                    const by2 = (mSat.y - bdy / bd * mSat.radius).toFixed(1);
                    d += ` M${jx.toFixed(1)},${jy.toFixed(1)} L${bx2},${by2}`;
                });

                path.setAttribute('d', d);
            }
        });

        // Hide paths for columns that are no longer active
        this._colEdgeMap.forEach((path, key) => {
            if (!active.has(key)) path.style.display = 'none';
        });
    }

    // ─── Hidden table visibility ─────────────────────────────────────────────

    _setHiddenVisibility(show) {
        this._showHidden = show;

        if (show) {
            // Scatter hidden nodes near centre before revealing them
            this._nodes.forEach(n => {
                if (!n._hideNode) return;
                n.x = (Math.random() - 0.5) * 150;
                n.y = (Math.random() - 0.5) * 150;
                n.vx = 0; n.vy = 0;
                if (n._grp) n._grp.style.display = '';
            });
            this._alpha = Math.max(this._alpha, 0.6);
        } else {
            this._nodes.forEach(n => {
                if (!n._hideNode) return;
                if (n._grp) n._grp.style.display = 'none';
                // Collapse any expanded satellites
                if (n.expanded) {
                    n.expanded = false;
                    n.satellites.forEach(sat => {
                        if (sat._grp)   sat._grp.style.display   = 'none';
                        if (sat._spoke) sat._spoke.style.display = 'none';
                    });
                    if (n._expandDot) n._expandDot.setAttribute('fill', 'white');
                }
            });
        }

        // Show/hide relationship edges that touch a hidden node
        this._edges.forEach(edge => {
            const a = this._nodes[edge.from];
            const b = this._nodes[edge.to];
            const hiddenEdge = !show && (a._hideNode || b._hideNode);
            if (edge._path)  edge._path.style.display  = hiddenEdge ? 'none' : '';
            if (edge._label) edge._label.style.display = hiddenEdge ? 'none' : '';
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
                this._dragging.node.x  = mx;
                this._dragging.node.y  = my;
                this._dragging.node.vx = 0;
                this._dragging.node.vy = 0;
                this._alpha = Math.max(this._alpha, 0.08);
            } else if (isPanning) {
                this._tx = e.clientX - panStart.x;
                this._ty = e.clientY - panStart.y;
                this._applyRootTransform();
            }
        };

        const onUp = () => {
            if (this._dragging) {
                this._dragging.node._pinned = false;
                this._dragging.node.vx = 0;
                this._dragging.node.vy = 0;
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

    // ─── Selection & detail panel ────────────────────────────────────────────

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
            this._renderTableDetail(panel, this._nodes[nodeIdx]);
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
        const rels = (this.model.relationships || []).filter(r =>
            r.fromTable === t.name || r.toTable === t.name
        );
        const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
            <div class="ont-legend-hint">Click to expand · Drag · Scroll to zoom</div>
        `;

        const hiddenCount = this._nodes.filter(n => n._hideNode).length;
        if (hiddenCount > 0) {
            const btn = document.createElement('button');
            btn.className = 'ont-hidden-toggle';
            btn.textContent = `Show hidden tables (${hiddenCount})`;
            btn.addEventListener('click', () => {
                const nowShow = !this._showHidden;
                this._setHiddenVisibility(nowShow);
                btn.textContent = nowShow
                    ? `Hide hidden tables (${hiddenCount})`
                    : `Show hidden tables (${hiddenCount})`;
                btn.classList.toggle('ont-hidden-toggle--active', nowShow);
            });
            div.appendChild(btn);
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
                props.push({ id: BASE_PROP + i * 1000 + pIdx++, name: c.name,
                    dataType: this._mapDataType(c.dataType), isHidden: !!c.isHidden, isMeasure: false });
            });
            (t.measures || []).forEach(m => {
                props.push({ id: BASE_PROP + i * 1000 + pIdx++, name: m.name,
                    dataType: 'Double', isHidden: !!m.isHidden, isMeasure: true,
                    formatString: m.formatString || '', description: m.description || '' });
            });
            return {
                id: BASE_ENT + i, name: t.name, description: t.description || '',
                isHidden: !!t.isHidden,
                entityKind: t._isFieldParameter ? 'FieldParameter' : t._isCalcGroup ? 'CalculationGroup' : 'Regular',
                properties: props
            };
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
        const map = { int64: 'BigInt', int32: 'BigInt', integer: 'BigInt',
            double: 'Double', decimal: 'Double', currency: 'Double', single: 'Double',
            string: 'String', text: 'String', boolean: 'Boolean',
            datetime: 'DateTime', date: 'DateTime', time: 'DateTime' };
        return map[(dt || '').toLowerCase()] || 'String';
    }

    _mkSVG(tag, attrs = {}) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
        return el;
    }
}

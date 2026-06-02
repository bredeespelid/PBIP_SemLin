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
    }

    destroy() {
        this._running = false;
        if (this._animFrame) {
            cancelAnimationFrame(this._animFrame);
            this._animFrame = null;
        }
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

        // Initial circular layout
        const n = nodes.length;
        const initR = Math.min(W, H) * 0.28;
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

        const edgeLayer = this._mkSVG('g', { id: 'ont-edges' });
        root.appendChild(edgeLayer);

        const nodeLayer = this._mkSVG('g', { id: 'ont-nodes' });
        root.appendChild(nodeLayer);

        this._createEdgeElements(edgeLayer);
        this._createNodeElements(nodeLayer, container);

        container.appendChild(svg);

        this._tx = 0;
        this._ty = 0;
        this._scale = 1;
        this._applyRootTransform();

        // Fade in
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

    _buildGraph() {
        const model = this.model;
        const tables = (model.tables || []).filter(t => !t._isAutoDate);
        const STYLES = {
            entity:     { color: '#2563eb', light: '#93c5fd', dark: '#1e40af' },
            fieldparam: { color: '#7c3aed', light: '#c4b5fd', dark: '#5b21b6' },
            calcgroup:  { color: '#ea580c', light: '#fdba74', dark: '#9a3412' },
            hidden:     { color: '#64748b', light: '#cbd5e1', dark: '#334155' },
        };

        const nodes = tables.map((t) => {
            let typeKey = 'entity';
            if (t._isFieldParameter) typeKey = 'fieldparam';
            else if (t._isCalcGroup) typeKey = 'calcgroup';
            else if (t.isHidden) typeKey = 'hidden';

            const s = STYLES[typeKey];
            const cols = (t.columns || []).filter(c => !c.isHidden);
            const measures = t.measures || [];
            const complexity = Math.min(cols.length + measures.length * 1.8, 90);
            const radius = Math.round(Math.max(32, Math.min(52, 30 + complexity * 0.22)));

            const words = t.name.replace(/[_-]/g, ' ').trim().split(/\s+/);
            const initials = words.length >= 2
                ? (words[0][0] + words[1][0]).toUpperCase()
                : t.name.slice(0, 2).toUpperCase();

            return {
                id: t.name, name: t.name, table: t,
                typeKey, ...s,
                radius, cols, measures,
                colCount: cols.length,
                measureCount: measures.length,
                initials,
                x: 0, y: 0, vx: 0, vy: 0,
                _pinned: false, _grp: null, _circle: null, _selected: false
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

    _addDefs(svg) {
        const defs = this._mkSVG('defs');
        this._defs = defs;

        // Arrowhead marker
        const mk = this._mkSVG('marker', {
            id: 'ont-arrow', markerWidth: '10', markerHeight: '7',
            refX: '9', refY: '3.5', orient: 'auto'
        });
        mk.appendChild(this._mkSVG('polygon', { points: '0 0,10 3.5,0 7', fill: '#94a3b8' }));
        defs.appendChild(mk);

        // Glow filter (selected)
        const fGlow = this._mkSVG('filter', { id: 'ont-glow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
        const feGB = this._mkSVG('feGaussianBlur', { stdDeviation: '7', result: 'coloredBlur' });
        const feMerge = this._mkSVG('feMerge');
        feMerge.appendChild(this._mkSVG('feMergeNode', { in: 'coloredBlur' }));
        feMerge.appendChild(this._mkSVG('feMergeNode', { in: 'SourceGraphic' }));
        fGlow.appendChild(feGB);
        fGlow.appendChild(feMerge);
        defs.appendChild(fGlow);

        // Drop shadow
        const fShadow = this._mkSVG('filter', { id: 'ont-shadow', x: '-30%', y: '-30%', width: '160%', height: '160%' });
        fShadow.appendChild(this._mkSVG('feDropShadow', { dx: '2', dy: '3', stdDeviation: '4', 'flood-opacity': '0.22' }));
        defs.appendChild(fShadow);

        svg.appendChild(defs);
    }

    _createNodeElements(nodeLayer, container) {
        this._nodes.forEach((node, i) => {
            const R = node.radius;

            // Per-node radial gradient
            const gid = `ont-grad-${i}`;
            const grad = this._mkSVG('radialGradient', { id: gid, cx: '38%', cy: '32%', r: '68%' });
            const s1 = this._mkSVG('stop', { offset: '0%' });
            s1.setAttribute('stop-color', node.light);
            const s2 = this._mkSVG('stop', { offset: '100%' });
            s2.setAttribute('stop-color', node.dark);
            grad.appendChild(s1);
            grad.appendChild(s2);
            this._defs.appendChild(grad);

            const grp = this._mkSVG('g');
            grp.classList.add('ont-node-grp');
            grp.dataset.nodeIdx = String(i);
            grp.style.cursor = 'pointer';

            // Outer glow ring
            const glowRing = this._mkSVG('circle', {
                r: R + 9, fill: 'none',
                stroke: node.color, 'stroke-width': '1.5',
                opacity: '0.15'
            });

            // Shadow
            const shadow = this._mkSVG('circle', { r: R + 2, cx: 2, cy: 4 });
            shadow.setAttribute('fill', 'rgba(0,0,0,0.18)');
            shadow.setAttribute('filter', 'url(#ont-shadow)');

            // Main circle
            const circle = this._mkSVG('circle', {
                r: R, fill: `url(#${gid})`,
                stroke: node.color, 'stroke-width': '2.5'
            });
            node._circle = circle;

            // Initials text
            const initText = this._mkSVG('text', {
                'text-anchor': 'middle', 'dominant-baseline': 'central',
                'font-size': Math.round(R * 0.5),
                fill: 'rgba(255,255,255,0.95)',
                'pointer-events': 'none',
                'font-weight': '700',
                'font-family': 'system-ui,-apple-system,sans-serif',
                y: node.measureCount > 0 ? -5 : 0
            });
            initText.textContent = node.initials;

            // Measure count (small, inside circle)
            if (node.measureCount > 0) {
                const mcText = this._mkSVG('text', {
                    'text-anchor': 'middle', 'dominant-baseline': 'central',
                    'font-size': '9', fill: 'rgba(255,255,255,0.7)',
                    'pointer-events': 'none',
                    'font-family': 'Consolas,monospace',
                    y: R * 0.44
                });
                mcText.textContent = `Σ ${node.measureCount}`;
                grp.appendChild(mcText);
            }

            // Name label below
            const label = this._mkSVG('text', {
                'text-anchor': 'middle', 'dominant-baseline': 'hanging',
                'font-size': '12', 'font-weight': '600',
                fill: 'var(--text, #1e293b)',
                'pointer-events': 'none',
                'font-family': 'system-ui,-apple-system,sans-serif',
                y: R + 8
            });
            const displayName = node.name.length > 22 ? node.name.slice(0, 20) + '…' : node.name;
            label.textContent = displayName;

            // Type badge below name
            const BADGES = { fieldparam: 'FIELD PARAM', calcgroup: 'CALC GROUP', hidden: 'HIDDEN' };
            if (BADGES[node.typeKey]) {
                const badge = this._mkSVG('text', {
                    'text-anchor': 'middle', 'dominant-baseline': 'hanging',
                    'font-size': '9', 'font-weight': '700',
                    fill: node.color, 'pointer-events': 'none',
                    y: R + 23
                });
                badge.textContent = BADGES[node.typeKey];
                grp.appendChild(badge);
            }

            grp.appendChild(glowRing);
            grp.appendChild(shadow);
            grp.appendChild(circle);
            grp.appendChild(initText);
            grp.appendChild(label);

            // Hover effect
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

            grp.addEventListener('click', (e) => {
                e.stopPropagation();
                this._selectNode(i, container);
            });

            grp.addEventListener('mousedown', (e) => {
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
            grp.classList.add('ont-edge-grp');

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
                'pointer-events': 'none',
                'font-family': 'system-ui,sans-serif'
            });
            lbl.textContent = edge.card;
            grp.appendChild(lbl);
            edge._label = lbl;

            edgeLayer.appendChild(grp);
        });
    }

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

            const REPK    = 7500;
            const SPRINGK = 0.032;
            const REST    = 185;
            const DAMP    = 0.80;
            const CENK    = 0.007;
            const nodes   = this._nodes;
            const edges   = this._edges;

            nodes.forEach(n => { n._fx = 0; n._fy = 0; });

            // N-body repulsion
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = nodes[i], b = nodes[j];
                    const dx = b.x - a.x, dy = b.y - a.y;
                    const d2 = dx * dx + dy * dy + 1;
                    const d  = Math.sqrt(d2);
                    const minD = a.radius + b.radius + 24;
                    const f = d < minD ? (REPK * 2.5) / d2 : REPK / d2;
                    const fx = f * dx / d, fy = f * dy / d;
                    a._fx -= fx; a._fy -= fy;
                    b._fx += fx; b._fy += fy;
                }
            }

            // Spring attraction along edges
            edges.forEach(e => {
                const a = nodes[e.from], b = nodes[e.to];
                const dx = b.x - a.x, dy = b.y - a.y;
                const d  = Math.sqrt(dx * dx + dy * dy) + 0.01;
                const f  = SPRINGK * (d - REST);
                const fx = f * dx / d, fy = f * dy / d;
                a._fx += fx; a._fy += fy;
                b._fx -= fx; b._fy -= fy;
            });

            // Weak center gravity
            nodes.forEach(n => { n._fx -= CENK * n.x; n._fy -= CENK * n.y; });

            // Euler integration
            nodes.forEach(n => {
                if (n._pinned) return;
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
            if (node._grp) {
                node._grp.setAttribute('transform',
                    `translate(${node.x.toFixed(1)},${node.y.toFixed(1)})`);
            }
        });

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

    _initInteraction(svg, container) {
        let isPanning = false;
        let panStart  = { x: 0, y: 0 };

        svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const f = e.deltaY > 0 ? 0.87 : 1.15;
            this._scale = Math.max(0.12, Math.min(4.5, this._scale * f));
            this._applyRootTransform();
        }, { passive: false });

        svg.addEventListener('mousedown', (e) => {
            if (e.button === 0 && !this._dragging) {
                isPanning = true;
                panStart  = { x: e.clientX - this._tx, y: e.clientY - this._ty };
                svg.style.cursor = 'grabbing';
            }
        });

        const onMove = (e) => {
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

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup',   onUp);

        const zIn    = container.querySelector('[data-ontology-zoom="in"]');
        const zOut   = container.querySelector('[data-ontology-zoom="out"]');
        const zReset = container.querySelector('[data-ontology-zoom="reset"]');
        if (zIn)    zIn.addEventListener('click',    () => { this._scale = Math.min(4.5, this._scale * 1.3); this._applyRootTransform(); });
        if (zOut)   zOut.addEventListener('click',   () => { this._scale = Math.max(0.12, this._scale / 1.3); this._applyRootTransform(); });
        if (zReset) zReset.addEventListener('click', () => { this._scale = 1; this._tx = 0; this._ty = 0; this._applyRootTransform(); });

        svg.addEventListener('click', () => this._deselectAll(container));
    }

    _selectNode(idx, container) {
        this._nodes.forEach((n, i) => {
            n._selected = (i === idx);
            if (!n._circle) return;
            if (i === idx) {
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
            this._renderDetail(panel, this._nodes[idx]);
        }
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

    _renderDetail(panel, node) {
        const t      = node.table;
        const cols   = node.cols;
        const msrs   = node.measures;
        const rels   = (this.model.relationships || []).filter(r =>
            r.fromTable === t.name || r.toTable === t.name
        );
        const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const TYPE_NAMES = {
            entity: 'Entity', fieldparam: 'Field Parameter',
            calcgroup: 'Calculation Group', hidden: 'Hidden Table'
        };

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
                <div class="ont-stat-cell"><div class="ont-stat-val">${cols.length}</div><div class="ont-stat-key">Columns</div></div>
                <div class="ont-stat-cell"><div class="ont-stat-val">${msrs.length}</div><div class="ont-stat-key">Measures</div></div>
                <div class="ont-stat-cell"><div class="ont-stat-val">${rels.length}</div><div class="ont-stat-key">Relations</div></div>
                <div class="ont-stat-cell"><div class="ont-stat-val">${(t.columns || []).filter(c => c.isHidden).length}</div><div class="ont-stat-key">Hidden</div></div>
            </div>
            ${cols.length > 0 ? `
            <div class="ont-section">
                <div class="ont-section-label">Properties (${Math.min(cols.length, 15)} of ${cols.length})</div>
                <ul class="ont-prop-list">
                    ${cols.slice(0, 15).map(c => `<li><span class="ont-prop-name">${esc(c.name)}</span><span class="ont-dtype">${c.dataType || '–'}</span></li>`).join('')}
                    ${cols.length > 15 ? `<li class="ont-more">+${cols.length - 15} more</li>` : ''}
                </ul>
            </div>` : ''}
            ${msrs.length > 0 ? `
            <div class="ont-section">
                <div class="ont-section-label">KPIs / Measures (${msrs.length})</div>
                <ul class="ont-prop-list">
                    ${msrs.slice(0, 8).map(m => `<li><span class="ont-kpi-name">Σ ${esc(m.name)}</span>${m.formatString ? `<span class="ont-dtype">${esc(m.formatString)}</span>` : ''}</li>`).join('')}
                    ${msrs.length > 8 ? `<li class="ont-more">+${msrs.length - 8} more</li>` : ''}
                </ul>
            </div>` : ''}
            ${rels.length > 0 ? `
            <div class="ont-section">
                <div class="ont-section-label">Relationships (${rels.length})</div>
                <ul class="ont-prop-list">
                    ${rels.slice(0, 10).map(r => {
                        const other = r.fromTable === t.name ? r.toTable : r.fromTable;
                        const dir   = r.fromTable === t.name ? '→' : '←';
                        const c1 = r.fromCardinality === 'Many' ? '*' : '1';
                        const c2 = r.toCardinality   === 'Many' ? '*' : '1';
                        return `<li><span class="ont-rel-dir">${dir}</span><span class="ont-prop-name">${esc(other)}</span><span class="ont-dtype">${c1}:${c2}</span></li>`;
                    }).join('')}
                </ul>
            </div>` : ''}
        `;
    }

    _addLegend(container) {
        const div = document.createElement('div');
        div.className = 'ont-legend';
        div.innerHTML = `
            <div class="ont-legend-title">Node Types</div>
            ${[
                { color: '#2563eb', label: 'Entity' },
                { color: '#7c3aed', label: 'Field Parameter' },
                { color: '#ea580c', label: 'Calc Group' },
                { color: '#64748b', label: 'Hidden' },
            ].map(it => `
                <div class="ont-legend-item">
                    <svg width="12" height="12" viewBox="0 0 12 12" style="flex-shrink:0">
                        <circle cx="6" cy="6" r="5" fill="${it.color}"/>
                    </svg>
                    <span>${it.label}</span>
                </div>`).join('')}
            <div class="ont-legend-sep"></div>
            <div class="ont-legend-hint">Drag · Scroll to zoom · Click to inspect</div>
        `;
        container.appendChild(div);
    }

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
            fromEntityId: entityIdx[r.fromTable],
            toEntityId:   entityIdx[r.toTable],
            fromColumn: r.fromColumn, toColumn: r.toColumn,
            fromCardinality: r.fromCardinality || 'Many',
            toCardinality:   r.toCardinality   || 'One',
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

#!/usr/bin/env node
/**
 * generate-docs.js  —  PBIP Documentation Generator (CLI)
 *
 * Usage:
 *   node generate-docs.js <path-to-pbip-folder> [--format md|json|html] [--scope model|visuals|all] [--out <file>]
 *
 * Examples:
 *   node generate-docs.js "C:\Reports\SalesModel"
 *   node generate-docs.js "C:\Reports\SalesModel" --format json --out docs.json
 *   node generate-docs.js "C:\Reports\SalesModel" --scope all --out full-docs.md
 *
 * No npm install needed — uses only the parser files already in this folder.
 *
 * Requirements: Node.js 18+
 */

'use strict';

const path = require('path');
const fs = require('fs').promises;

// ── Load parsers (same files used by the browser app) ────────────────────────
const { TMDLParser, DAXReferenceExtractor } = require('./tmdl-parser.js');
const VisualParser  = require('./visual-parser.js');
const MExpressionParser = require('./m-parser.js');
const LineageEngine = require('./lineage-engine.js');
const DocGenerator  = require('./doc-generator.js');

// Make globals available (lineage-engine and doc-generator reference them as globals)
global.TMDLParser            = TMDLParser;
global.DAXReferenceExtractor = DAXReferenceExtractor;
global.VisualParser          = VisualParser;
global.MExpressionParser     = MExpressionParser;
global.LineageEngine         = LineageEngine;
global.DocGenerator          = DocGenerator;

// ── CLI argument parsing ──────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    if (!args.length || args[0] === '--help' || args[0] === '-h') {
        console.log([
            '',
            'PBIP Documentation Generator',
            '',
            'Usage:',
            '  node generate-docs.js <path> [options]',
            '',
            'Options:',
            '  --format  md | json | html   Output format (default: md)',
            '  --scope   model | visuals | all  What to include (default: all)',
            '  --out     <file>             Output file (default: <ModelName>-docs.<ext>)',
            '',
            'Examples:',
            '  node generate-docs.js "C:\\Reports\\SalesModel"',
            '  node generate-docs.js "." --format json',
            '  node generate-docs.js "." --scope all --out docs.md',
            ''
        ].join('\n'));
        process.exit(0);
    }

    const config = { pbipPath: args[0], format: 'md', scope: 'all', out: null };
    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--format' && args[i + 1]) config.format = args[++i];
        else if (args[i] === '--scope'  && args[i + 1]) config.scope  = args[++i];
        else if (args[i] === '--out'    && args[i + 1]) config.out    = args[++i];
    }
    return config;
}

// ── File system helpers ───────────────────────────────────────────────────────
async function findSemanticModelFolder(basePath) {
    if (basePath.endsWith('.SemanticModel')) return basePath;
    const entries = await fs.readdir(basePath, { withFileTypes: true });
    for (const e of entries) {
        if (e.isDirectory() && e.name.endsWith('.SemanticModel'))
            return path.join(basePath, e.name);
    }
    return null;
}

async function findReportFolder(basePath) {
    if (basePath.endsWith('.Report')) return basePath;
    try {
        const entries = await fs.readdir(basePath, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory() && e.name.endsWith('.Report'))
                return path.join(basePath, e.name);
        }
    } catch { /* no .Report */ }
    return null;
}

async function readTMDLFiles(smPath) {
    const files = {};
    const defPath = path.join(smPath, 'definition');

    for (const entry of await fs.readdir(defPath, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.tmdl'))
            files[entry.name] = await fs.readFile(path.join(defPath, entry.name), 'utf-8');
    }

    for (const subdir of ['tables', 'roles']) {
        try {
            const subPath = path.join(defPath, subdir);
            for (const entry of await fs.readdir(subPath, { withFileTypes: true })) {
                if (entry.isFile() && entry.name.endsWith('.tmdl'))
                    files[`${subdir}/${entry.name}`] =
                        await fs.readFile(path.join(subPath, entry.name), 'utf-8');
            }
        } catch { /* folder may not exist */ }
    }

    return files;
}

async function readReportFiles(reportPath) {
    const pages = [];
    const pagesPath = path.join(reportPath, 'definition', 'pages');
    let pageEntries;
    try { pageEntries = await fs.readdir(pagesPath, { withFileTypes: true }); }
    catch { return pages; }

    for (const pageEntry of pageEntries) {
        if (!pageEntry.isDirectory()) continue;
        const pageDir = path.join(pagesPath, pageEntry.name);
        let pageData = {};
        try { pageData = JSON.parse(await fs.readFile(path.join(pageDir, 'page.json'), 'utf-8')); }
        catch { /* missing page.json */ }

        const visuals = [];
        try {
            const visualsPath = path.join(pageDir, 'visuals');
            for (const ve of await fs.readdir(visualsPath, { withFileTypes: true })) {
                if (!ve.isDirectory()) continue;
                try {
                    const vj = JSON.parse(
                        await fs.readFile(path.join(visualsPath, ve.name, 'visual.json'), 'utf-8')
                    );
                    visuals.push({ visualId: ve.name, visualData: vj });
                } catch { /* skip */ }
            }
        } catch { /* no visuals folder */ }

        pages.push({
            pageId: pageEntry.name,
            pageName: pageData.name || pageEntry.name,
            displayName: pageData.displayName || pageData.name || pageEntry.name,
            pageWidth: pageData.width || null,
            pageHeight: pageData.height || null,
            pageBinding: pageData.pageBinding || null,
            visuals
        });
    }
    return pages;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const { pbipPath, format, scope, out } = parseArgs();
    const basePath = path.resolve(pbipPath);

    // Resolve folders
    const smPath = await findSemanticModelFolder(basePath);
    if (!smPath) {
        console.error(`Error: No .SemanticModel folder found in: ${basePath}`);
        process.exit(1);
    }

    const reportPath = await findReportFolder(basePath);
    if (!reportPath && (scope === 'visuals' || scope === 'all')) {
        console.warn('Warning: No .Report folder found — visual data will be empty.');
    }

    // Parse
    process.stderr.write('Parsing TMDL files...\n');
    const files = await readTMDLFiles(smPath);
    const reportPages = reportPath ? await readReportFiles(reportPath) : [];

    const parser = new TMDLParser();
    const parsedModel = parser.parseAll(files);
    const measureRefs = parser.extractAllReferences();

    const visualParser = new VisualParser();
    const visualData = visualParser.parseReport(reportPages);

    process.stderr.write('Building lineage graph...\n');
    const lineageEngine = new LineageEngine(parsedModel, visualData, measureRefs);
    lineageEngine.buildGraph();

    const docGen = new DocGenerator(parsedModel, visualData, measureRefs, lineageEngine);

    // Generate output
    process.stderr.write('Generating documentation...\n');
    let output;
    let ext;
    if (format === 'json') {
        output = docGen.generateJSON();
        ext = 'json';
    } else if (format === 'html') {
        output = docGen.generateHTML();
        ext = 'html';
    } else {
        output = docGen.generateMarkdown(scope);
        ext = 'md';
    }

    // Write file
    const modelName = parsedModel.database?.name || parsedModel.model?.name || 'model';
    const safeName = modelName.replace(/[^a-z0-9_-]/gi, '_');
    const outFile = out || path.join(basePath, `${safeName}-docs.${ext}`);

    await fs.writeFile(outFile, output, 'utf-8');

    const visibleTables = parsedModel.tables.filter(t => !t._isAutoDate).length;
    const totalMeasures = parsedModel.tables.flatMap(t => t.measures || []).length;

    console.log([
        '',
        `Done! Documentation written to:`,
        `  ${outFile}`,
        '',
        `  Model:     ${modelName}`,
        `  Tables:    ${visibleTables}`,
        `  Measures:  ${totalMeasures}`,
        `  Pages:     ${reportPages.length}`,
        `  Format:    ${ext.toUpperCase()}`,
        ''
    ].join('\n'));
}

main().catch(err => {
    console.error(`\nError: ${err.message}\n`);
    process.exit(1);
});

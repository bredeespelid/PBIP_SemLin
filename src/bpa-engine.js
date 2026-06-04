/**
 * PBIP SemLin — Best Practice Analyzer (BPA) Engine
 * Evaluates semantic models against defined rules to ensure performance, formatting, layout, and naming conventions.
 */

const BPARules = [
  {
    "ID": "DAX_COLUMNS_FULLY_QUALIFIED",
    "Name": "Fully qualify column references",
    "Category": "DAX Expressions",
    "Description": "Using fully qualified column references ('Table'[Column]) makes it easy to distinguish between columns and measures, and prevents syntax errors or structural confusion in complex expressions.",
    "Severity": 2,
    "Scope": "Measure, Calculated Column",
    "evalJS": (model) => {
      const findings = [];
      const columnNames = new Set(model.tables.flatMap(t => t.columns.map(c => c.name)));
      const measureNames = new Set(model.tables.flatMap(t => t.measures.map(m => m.name)));

      model.tables.forEach(t => {
        if (t._isAutoDate) return;
        const measures = new Set(t.measures.map(m => m.name));
        const objects = [
          ...t.measures.map(m => ({ ...m, _isMeasure: true })),
          ...t.columns.filter(c => c.expression).map(c => ({ ...c, _isMeasure: false }))
        ];

        objects.forEach(obj => {
          if (!obj.expression) return;

          // Match all unqualified [Bracketed] names not preceded by quote or word char
          const matches = obj.expression.matchAll(/(?<!['"\w\d])\[([^\]]+)\]/g);
          for (const match of matches) {
            const name = match[1];
            // If it is a column name and not a measure name, it is an unqualified column reference!
            if (columnNames.has(name) && !measureNames.has(name)) {
              findings.push({
                table: t.name,
                object: obj.name,
                type: obj._isMeasure ? 'Measure' : 'Calculated Column',
                message: `Object [${obj.name}] contains an unqualified column reference [${name}]. Use 'Table'[${name}] instead.`
              });
            }
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "DAX_DIVISION_COLUMNS",
    "Name": "Avoid division operator (use DIVIDE)",
    "Category": "DAX Expressions",
    "Description": "It is recommended to use the DIVIDE function instead of the slash operator (/) to safely handle division by zero, unless the denominator is a constant.",
    "Severity": 3,
    "Scope": "Measure, Calculated Column",
    "evalJS": (model) => {
      const findings = [];
      model.tables.forEach(t => {
        if (t._isAutoDate) return;
        const objects = [...t.measures, ...t.columns.filter(c => c.expression)];
        
        objects.forEach(obj => {
          if (!obj.expression) return;
          // Strip comments and string literals to prevent false positives
          // (string literals can contain HTML like </div> which contains '/')
          const cleanExpr = obj.expression
            .replace(/\/\/.*/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/"(?:[^"]|"")*"/g, '""');

          if (cleanExpr.includes('/') && !/\/\s*\d+(\.\d+)?\b/.test(cleanExpr) && !/[a-zA-Z0-9_ -]+\/[a-zA-Z0-9_ -]+\.md/.test(cleanExpr)) {
            findings.push({
              table: t.name,
              object: obj.name,
              type: 'DAX',
              message: `Consider replacing the '/' operator with the DIVIDE function in [${obj.name}] for safer division-by-zero handling.`
            });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "DAX_MEASURES_UNQUALIFIED",
    "Name": "Do not qualify measure references",
    "Category": "DAX Expressions",
    "Description": "Measures should be referenced without table names. This makes it easier to move measures between tables and provides a clear visual distinction from columns.",
    "Severity": 2,
    "Scope": "Measure, Calculated Column",
    "evalJS": (model) => {
      const findings = [];
      const measureNames = new Set(model.tables.flatMap(t => t.measures.map(m => m.name)));
      
      model.tables.forEach(t => {
        if (t._isAutoDate) return;
        const objects = [...t.measures, ...t.columns.filter(c => c.expression)];
        objects.forEach(obj => {
          if (!obj.expression) return;
          
          // Match any qualified reference: Table[Name] or 'Table'[Name]
          const matches = obj.expression.matchAll(/(?:('([^']+)'|\b(\w+)))\[([^\]]+)\]/g);
          for (const match of matches) {
            const refName = match[4];
            if (measureNames.has(refName)) {
              findings.push({
                table: t.name,
                object: obj.name,
                type: 'DAX',
                message: `Object [${obj.name}] references measure [${refName}] with a table prefix. Remove the table name prefix.`
              });
            }
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "DAX_TODO",
    "Name": "Resolve TODO markers in DAX",
    "Category": "DAX Expressions",
    "Description": "Objects containing 'TODO' text in their expressions or comments should be completed and cleared before the model is published.",
    "Severity": 1,
    "Scope": "Measure, Column",
    "evalJS": (model) => {
      const findings = [];
      model.tables.forEach(t => {
        const objects = [...t.measures, ...t.columns.filter(c => c.expression)];
        objects.forEach(obj => {
          if (obj.expression && obj.expression.toUpperCase().includes('TODO')) {
            findings.push({
              table: t.name,
              object: obj.name,
              type: 'DAX',
              message: `Object [${obj.name}] contains a TODO comment or flag that should be resolved.`
            });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "APPLY_FORMAT_STRING_COLUMNS",
    "Name": "Provide format string for numeric columns",
    "Category": "Formatting",
    "Description": "Visible numeric columns should have a defined format string to ensure consistent and localized display within reports.",
    "Severity": 2,
    "Scope": "Column",
    "evalJS": (model) => {
      const findings = [];
      const numTypes = ['Int64', 'Double', 'Decimal', 'DateTime'];
      model.tables.forEach(t => {
        if (t._isAutoDate) return;
        t.columns.forEach(c => {
          if (!c.isHidden && numTypes.includes(c.dataType) && (!c.formatString || c.formatString.trim() === '')) {
            findings.push({
              table: t.name,
              object: c.name,
              type: 'Column',
              message: `Visible numeric column [${c.name}] has no format string defined.`
            });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "APPLY_FORMAT_STRING_MEASURES",
    "Name": "Provide format string for measures",
    "Category": "Formatting",
    "Description": "All visible measures should have an explicitly assigned format string (e.g., currency, percentage, or decimal format).",
    "Severity": 2,
    "Scope": "Measure",
    "evalJS": (model) => {
      const findings = [];
      model.tables.forEach(t => {
        t.measures.forEach(m => {
          if (!m.isHidden && (!m.formatString || m.formatString.trim() === '')) {
            findings.push({
              table: t.name,
              object: m.name,
              type: 'Measure',
              message: `Visible measure [${m.name}] has no format string defined.`
            });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "META_AVOID_FLOAT",
    "Name": "Avoid float data types (Double)",
    "Category": "Metadata",
    "Description": "Use 'Decimal' (Fixed Decimal Number) instead of 'Double' (Float) wherever possible to avoid unexpected rounding errors in financial and aggregative calculations.",
    "Severity": 3,
    "Scope": "Column",
    "evalJS": (model) => {
      const findings = [];
      model.tables.forEach(t => {
        t.columns.forEach(c => {
          if (c.dataType === 'Double') {
            findings.push({
              table: t.name,
              object: c.name,
              type: 'Column',
              message: `Column [${c.name}] uses data type 'Double' (float). Consider altering to 'Decimal' for financial precision.`
            });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "META_SUMMARIZE_NONE",
    "Name": "Disable automatic summarization",
    "Category": "Metadata",
    "Description": "Set 'SummarizeBy' to 'None' for numeric columns. Rely on explicit measures for business aggregation instead of implicit summaries.",
    "Severity": 1,
    "Scope": "Column",
    "evalJS": (model) => {
      const findings = [];
      const numTypes = ['Int64', 'Double', 'Decimal'];
      model.tables.forEach(t => {
        if (t._isAutoDate) return;
        t.columns.forEach(c => {
          if (!c.isHidden && numTypes.includes(c.dataType) && c.summarizeBy && c.summarizeBy.toLowerCase() !== 'none') {
            findings.push({
              table: t.name,
              object: c.name,
              type: 'Column',
              message: `Column [${c.name}] has automatic summarization enabled. Set SummarizeBy to 'None'.`
            });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "LAYOUT_HIDE_FK_COLUMNS",
    "Name": "Hide foreign key columns",
    "Category": "Model Layout",
    "Description": "Columns utilized in relationship maps should be hidden from end-users to prevent direct filtering on keys instead of dimensions.",
    "Severity": 1,
    "Scope": "Column",
    "evalJS": (model) => {
      const findings = [];
      const relColumns = new Set(model.relationships.map(r => `${r.fromTable}|${r.fromColumn}`));
      
      model.tables.forEach(t => {
        t.columns.forEach(c => {
          if (!c.isHidden && relColumns.has(`${t.name}|${c.name}`)) {
            findings.push({
              table: t.name,
              object: c.name,
              type: 'Column',
              message: `Foreign key column [${c.name}] is visible. It should be hidden.`
            });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "UPPERCASE_FIRST_LETTER",
    "Name": "Capitalized names",
    "Category": "Naming Convention",
    "Description": "Tables, columns, and measures should start with an uppercase letter to maintain a professional, standardized taxonomy.",
    "Severity": 2,
    "Scope": "All",
    "evalJS": (model) => {
      const findings = [];
      model.tables.forEach(t => {
        if (t._isAutoDate) return;
        if (t.name[0] !== t.name[0].toUpperCase()) {
          findings.push({ table: t.name, object: t.name, type: 'Table', message: `Table [${t.name}] starts with a lowercase letter.` });
        }
        t.columns.forEach(c => {
          if (!c.isHidden && c.name[0] !== c.name[0].toUpperCase()) {
            findings.push({ table: t.name, object: c.name, type: 'Column', message: `Column [${c.name}] starts with a lowercase letter.` });
          }
        });
        t.measures.forEach(m => {
          if (m.name[0] !== m.name[0].toUpperCase()) {
            findings.push({ table: t.name, object: m.name, type: 'Measure', message: `Measure [${m.name}] starts with a lowercase letter.` });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "PERF_UNUSED_COLUMNS",
    "Name": "Remove unused columns",
    "Category": "Performance",
    "Description": "Hidden columns that are not referenced in relationships, DAX formulas, or visuals consume memory in the in-memory engine. Consider removing them.",
    "Severity": 2,
    "Scope": "Column",
    "evalJS": (model) => {
      const findings = [];
      const allExpressions = model.tables.flatMap(t => [
        ...t.measures.map(m => m.expression),
        ...t.columns.map(c => c.expression)
      ]).filter(Boolean).join(' ');
      
      const relCols = new Set([
        ...model.relationships.map(r => `${r.fromTable}|${r.fromColumn}`),
        ...model.relationships.map(r => `${r.toTable}|${r.toColumn}`)
      ]);

      model.tables.forEach(t => {
        if (t._isAutoDate) return;
        t.columns.forEach(c => {
          if (c.isHidden && !relCols.has(`${t.name}|${c.name}`) && !allExpressions.includes(`[${c.name}]`)) {
            findings.push({
              table: t.name,
              object: c.name,
              type: 'Column',
              message: `Column [${c.name}] is hidden and does not appear to be used in any measure, column, or relationship.`
            });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "LAYOUT_MEASURES_DF",
    "Name": "Organize measures in display folders",
    "Category": "Model Layout",
    "Description": "Visible measures without a display folder are harder to find and navigate. Group related measures into display folders for better usability.",
    "Severity": 1,
    "Scope": "Measure",
    "evalJS": (model) => {
      const findings = [];
      model.tables.forEach(t => {
        if (t._isAutoDate) return;
        t.measures.forEach(m => {
          if (!m.isHidden && !m.displayFolder) {
            findings.push({ table: t.name, object: m.name, type: 'Measure', message: `Measure [${m.name}] is visible but has no display folder.` });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "NO_CAMELCASE_MEASURES_TABLES",
    "Name": "Avoid camelCase on visible measures and tables",
    "Category": "Naming Convention",
    "Description": "Visible measures and tables should use Title Case or spaces rather than camelCase to improve readability in the Power BI field list.",
    "Severity": 2,
    "Scope": "Measure, Table",
    "evalJS": (model) => {
      const findings = [];
      const isCamelCase = (name) => /[a-z][A-Z]/.test(name);
      model.tables.forEach(t => {
        if (t._isAutoDate) return;
        if (isCamelCase(t.name)) {
          findings.push({ table: t.name, object: t.name, type: 'Table', message: `Table [${t.name}] uses camelCase naming.` });
        }
        t.measures.forEach(m => {
          if (!m.isHidden && isCamelCase(m.name)) {
            findings.push({ table: t.name, object: m.name, type: 'Measure', message: `Measure [${m.name}] uses camelCase naming.` });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "NO_CAMELCASE_COLUMNS_HIERARCHIES",
    "Name": "Avoid camelCase on visible columns and hierarchies",
    "Category": "Naming Convention",
    "Description": "Visible columns and hierarchy levels should use Title Case or spaces rather than camelCase to improve readability in the Power BI field list.",
    "Severity": 2,
    "Scope": "Column",
    "evalJS": (model) => {
      const findings = [];
      const isCamelCase = (name) => /[a-z][A-Z]/.test(name);
      model.tables.forEach(t => {
        if (t._isAutoDate) return;
        t.columns.forEach(c => {
          if (!c.isHidden && isCamelCase(c.name)) {
            findings.push({ table: t.name, object: c.name, type: 'Column', message: `Column [${c.name}] uses camelCase naming.` });
          }
        });
        (t.hierarchies || []).forEach(h => {
          if (!h.isHidden && isCamelCase(h.name)) {
            findings.push({ table: t.name, object: h.name, type: 'Hierarchy', message: `Hierarchy [${h.name}] uses camelCase naming.` });
          }
        });
      });
      return findings;
    }
  },
  {
    "ID": "RELATIONSHIP_COLUMN_NAMES",
    "Name": "Names of columns in relationships should be the same",
    "Category": "Naming Convention",
    "Description": "When two columns are related, their names should ideally match to make the data model easier to understand and navigate.",
    "Severity": 2,
    "Scope": "Relationship",
    "evalJS": (model) => {
      const findings = [];
      model.relationships.forEach(rel => {
        if (rel.fromColumn !== rel.toColumn) {
          findings.push({
            table: rel.fromTable,
            object: `${rel.fromTable}[${rel.fromColumn}] → ${rel.toTable}[${rel.toColumn}]`,
            type: 'Relationship',
            message: `Relationship column name mismatch: [${rel.fromColumn}] → [${rel.toColumn}]. Consider renaming columns to match.`
          });
        }
      });
      return findings;
    }
  },
  {
    "ID": "DISABLE_AUTO_DATE_TIME",
    "Name": "Disable Auto Date/Time",
    "Category": "Model Layout",
    "Description": "Power BI's automatic date/time feature creates hidden localized date tables behind the scenes, bloating dataset memory overhead. Use a centralized calendar dimension in your model.",
    "Severity": 3,
    "Scope": "Model",
    "evalJS": (model) => {
      const findings = [];
      const autoDateTables = model.tables.filter(t => t._isAutoDate);
      if (autoDateTables.length > 0) {
        findings.push({
          table: 'Global',
          object: 'Model',
          type: 'Model',
          message: `The model contains ${autoDateTables.length} automatic date tables. Disable 'Auto date/time' in Power BI file settings.`
        });
      }
      return findings;
    }
  }
];

class BPAEngine {
    static evaluate(model) {
        if (!model) return { findings: [], score: 100, stats: { critical: 0, warning: 0, info: 0 } };

        const findings = [];
        let criticalCount = 0;
        let warningCount = 0;
        let infoCount = 0;

        BPARules.forEach(rule => {
            try {
                const ruleViolations = rule.evalJS(model);
                ruleViolations.forEach(violation => {
                    findings.push({
                        id: rule.ID,
                        name: rule.Name,
                        category: rule.Category,
                        description: rule.Description,
                        severity: rule.Severity,
                        table: violation.table,
                        object: violation.object,
                        type: violation.type,
                        message: violation.message
                    });

                    // Count severities
                    if (rule.Severity === 3) criticalCount++;
                    else if (rule.Severity === 2) warningCount++;
                    else if (rule.Severity === 1) infoCount++;
                });
            } catch (err) {
                console.error(`BPA Engine failed to run rule ${rule.ID}:`, err);
            }
        });

        // Smart, proportional compliance scoring
        // Total checkable items = tables + visible columns + measures
        let totalItems = 0;
        model.tables.forEach(t => {
            if (!t._isAutoDate) {
                totalItems += 1 + t.columns.filter(c => !c.isHidden).length + t.measures.length;
            }
        });
        if (totalItems === 0) totalItems = 1;

        // Weighting system: Critical = 3 pts penalty, Warning = 1 pt, Info = 0.2 pt.
        const totalPenalty = (criticalCount * 3) + (warningCount * 1) + (infoCount * 0.2);
        
        // Deduction percentage is penalty/totalItems scaled back nicely, capped properly
        const deductionPercent = (totalPenalty / totalItems) * 100;
        const score = Math.max(0, Math.min(100, Math.round(100 - deductionPercent)));

        return {
            findings,
            score,
            stats: {
                critical: criticalCount,
                warning: warningCount,
                info: infoCount
            }
        };
    }
}

// Export for app
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { BPAEngine, BPARules };
} else {
    window.BPAEngine = BPAEngine;
    window.BPARules = BPARules;
}

/**
 * CI validation tests - validates committed database in repository
 *
 * Purpose: Every PR should validate the database currently committed in git
 * - Database is updated via n8n updates (see MEMORY_N8N_UPDATE.md)
 * - CI always checks the committed database passes validation
 * - If database missing from repo, tests FAIL (critical issue)
 *
 * Tests verify:
 * 1. Database file exists in repo
 * 2. All tables are populated
 * 3. FTS5 index is synchronized
 * 4. Critical searches work
 * 5. Performance baselines met
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDatabaseAdapter } from '../../../src/database/database-adapter';
import { NodeRepository } from '../../../src/database/node-repository';
import * as fs from 'fs';

// Database path - must be committed to git
const dbPath = './data/nodes.db';
const dbExists = fs.existsSync(dbPath);

describe('CI Database Population Validation', () => {
  // First test: Database must exist in repository
  it('[CRITICAL] Database file must exist in repository', () => {
    expect(dbExists,
      `CRITICAL: Database not found at ${dbPath}! ` +
      'Database must be committed to git. ' +
      'If this is a fresh checkout, the database is missing from the repository.'
    ).toBe(true);
  });
});

// Only run remaining tests if database exists
describe.skipIf(!dbExists)('Database Content Validation', () => {
  let db: any;
  let repository: NodeRepository;

  beforeAll(async () => {
    // ALWAYS use production database path for CI validation
    // Ignore NODE_DB_PATH env var which might be set to :memory: by vitest
    db = await createDatabaseAdapter(dbPath);
    repository = new NodeRepository(db);
    console.log('✅ Database found - running validation tests');
  });

  describe('[CRITICAL] Database Must Have Data', () => {
    it('MUST have nodes table populated', () => {
      const count = db.prepare('SELECT COUNT(*) as count FROM nodes').get();

      expect(count.count,
        'CRITICAL: nodes table is EMPTY! Run: npm run rebuild'
      ).toBeGreaterThan(0);

      expect(count.count,
        `WARNING: Expected at least 500 nodes, got ${count.count}. Check if both n8n packages were loaded.`
      ).toBeGreaterThanOrEqual(500);
    });

    it('MUST have FTS5 table created', () => {
      const result = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='nodes_fts'
      `).get();

      expect(result,
        'CRITICAL: nodes_fts FTS5 table does NOT exist! Schema is outdated. Run: npm run rebuild'
      ).toBeDefined();
    });

    it('MUST have FTS5 index populated', () => {
      const ftsCount = db.prepare('SELECT COUNT(*) as count FROM nodes_fts').get();

      expect(ftsCount.count,
        'CRITICAL: FTS5 index is EMPTY! Searches will return zero results. Run: npm run rebuild'
      ).toBeGreaterThan(0);
    });

    it('MUST have FTS5 synchronized with nodes', () => {
      const nodesCount = db.prepare('SELECT COUNT(*) as count FROM nodes').get();
      const ftsCount = db.prepare('SELECT COUNT(*) as count FROM nodes_fts').get();

      expect(ftsCount.count,
        `CRITICAL: FTS5 out of sync! nodes: ${nodesCount.count}, FTS5: ${ftsCount.count}. Run: npm run rebuild`
      ).toBe(nodesCount.count);
    });
  });

  describe('[CRITICAL] Production Search Scenarios Must Work', () => {
    const criticalSearches = [
      { term: 'webhook', expectedNode: 'nodes-base.webhook', description: 'webhook node (39.6% user adoption)' },
      { term: 'merge', expectedNode: 'nodes-base.merge', description: 'merge node (10.7% user adoption)' },
      { term: 'code', expectedNode: 'nodes-base.code', description: 'code node (59.5% user adoption)' },
      { term: 'http', expectedNode: 'nodes-base.httpRequest', description: 'http request node (55.1% user adoption)' },
      { term: 'split', expectedNode: 'nodes-base.splitInBatches', description: 'split in batches node' },
    ];

    criticalSearches.forEach(({ term, expectedNode, description }) => {
      it(`MUST find ${description} via FTS5 search`, () => {
        const results = db.prepare(`
          SELECT node_type FROM nodes_fts
          WHERE nodes_fts MATCH ?
        `).all(term);

        expect(results.length,
          `CRITICAL: FTS5 search for "${term}" returned ZERO results! This was a production failure case.`
        ).toBeGreaterThan(0);

        const nodeTypes = results.map((r: any) => r.node_type);
        expect(nodeTypes,
          `CRITICAL: Expected node "${expectedNode}" not found in FTS5 search results for "${term}"`
        ).toContain(expectedNode);
      });

      it(`MUST find ${description} via LIKE fallback search`, () => {
        const results = db.prepare(`
          SELECT node_type FROM nodes
          WHERE node_type LIKE ? OR display_name LIKE ? OR description LIKE ?
        `).all(`%${term}%`, `%${term}%`, `%${term}%`);

        expect(results.length,
          `CRITICAL: LIKE search for "${term}" returned ZERO results! Fallback is broken.`
        ).toBeGreaterThan(0);

        const nodeTypes = results.map((r: any) => r.node_type);
        expect(nodeTypes,
          `CRITICAL: Expected node "${expectedNode}" not found in LIKE search results for "${term}"`
        ).toContain(expectedNode);
      });
    });
  });

  describe('[REQUIRED] All Tables Must Be Populated', () => {
    it('MUST have both n8n-nodes-base and langchain nodes', () => {
      const baseNodesCount = db.prepare(`
        SELECT COUNT(*) as count FROM nodes
        WHERE package_name = 'n8n-nodes-base'
      `).get();

      const langchainNodesCount = db.prepare(`
        SELECT COUNT(*) as count FROM nodes
        WHERE package_name = '@n8n/n8n-nodes-langchain'
      `).get();

      expect(baseNodesCount.count,
        'CRITICAL: No n8n-nodes-base nodes found! Package loading failed.'
      ).toBeGreaterThan(400); // Should have ~438 nodes

      expect(langchainNodesCount.count,
        'CRITICAL: No langchain nodes found! Package loading failed.'
      ).toBeGreaterThan(90); // Should have ~98 nodes
    });

    it('MUST have AI tools identified', () => {
      const aiToolsCount = db.prepare(`
        SELECT COUNT(*) as count FROM nodes
        WHERE is_ai_tool = 1
      `).get();

      expect(aiToolsCount.count,
        'WARNING: No AI tools found. Check AI tool detection logic.'
      ).toBeGreaterThan(260); // Should have ~269 AI tools
    });

    it('MUST have trigger nodes identified', () => {
      const triggersCount = db.prepare(`
        SELECT COUNT(*) as count FROM nodes
        WHERE is_trigger = 1
      `).get();

      expect(triggersCount.count,
        'WARNING: No trigger nodes found. Check trigger detection logic.'
      ).toBeGreaterThan(100); // Should have ~108 triggers
    });

    it('MUST have templates table (optional but recommended)', () => {
      const templatesCount = db.prepare('SELECT COUNT(*) as count FROM templates').get();

      if (templatesCount.count === 0) {
        console.warn('WARNING: No workflow templates found. Run: npm run fetch:templates');
      }
      // This is not critical, so we don't fail the test
      expect(templatesCount.count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('[VALIDATION] FTS5 Triggers Must Be Active', () => {
    it('MUST have all FTS5 triggers created', () => {
      const triggers = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='trigger' AND name LIKE 'nodes_fts_%'
      `).all();

      expect(triggers.length,
        'CRITICAL: FTS5 triggers are missing! Index will not stay synchronized.'
      ).toBe(3);

      const triggerNames = triggers.map((t: any) => t.name);
      expect(triggerNames).toContain('nodes_fts_insert');
      expect(triggerNames).toContain('nodes_fts_update');
      expect(triggerNames).toContain('nodes_fts_delete');
    });

    it('MUST have FTS5 index properly ranked', () => {
      const results = db.prepare(`
        SELECT node_type, rank FROM nodes_fts
        WHERE nodes_fts MATCH 'webhook'
        ORDER BY rank
        LIMIT 5
      `).all();

      expect(results.length,
        'CRITICAL: FTS5 ranking not working. Search quality will be degraded.'
      ).toBeGreaterThan(0);

      // Exact match should be in top results
      const topNodes = results.slice(0, 3).map((r: any) => r.node_type);
      expect(topNodes,
        'WARNING: Exact match "nodes-base.webhook" not in top 3 ranked results'
      ).toContain('nodes-base.webhook');
    });
  });

  describe('[PERFORMANCE] Search Performance Baseline', () => {
    it('FTS5 search should be fast (< 100ms for simple query)', () => {
      const start = Date.now();

      db.prepare(`
        SELECT node_type FROM nodes_fts
        WHERE nodes_fts MATCH 'webhook'
        LIMIT 20
      `).all();

      const duration = Date.now() - start;

      if (duration > 100) {
        console.warn(`WARNING: FTS5 search took ${duration}ms (expected < 100ms). Database may need optimization.`);
      }

      expect(duration).toBeLessThan(1000); // Hard limit: 1 second
    });

    it('LIKE search should be reasonably fast (< 500ms for simple query)', () => {
      const start = Date.now();

      db.prepare(`
        SELECT node_type FROM nodes
        WHERE node_type LIKE ? OR display_name LIKE ? OR description LIKE ?
        LIMIT 20
      `).all('%webhook%', '%webhook%', '%webhook%');

      const duration = Date.now() - start;

      if (duration > 500) {
        console.warn(`WARNING: LIKE search took ${duration}ms (expected < 500ms). Consider optimizing.`);
      }

      expect(duration).toBeLessThan(2000); // Hard limit: 2 seconds
    });
  });

  describe('[DOCUMENTATION] Database Quality Metrics', () => {
    it('should have high documentation coverage', () => {
      const withDocs = db.prepare(`
        SELECT COUNT(*) as count FROM nodes
        WHERE documentation IS NOT NULL AND documentation != ''
      `).get();

      const total = db.prepare('SELECT COUNT(*) as count FROM nodes').get();
      const coverage = (withDocs.count / total.count) * 100;

      console.log(`📚 Documentation coverage: ${coverage.toFixed(1)}% (${withDocs.count}/${total.count})`);

      expect(coverage,
        'WARNING: Documentation coverage is low. Some nodes may not have help text.'
      ).toBeGreaterThan(80); // At least 80% coverage
    });

    it('should have properties extracted for most nodes', () => {
      const withProps = db.prepare(`
        SELECT COUNT(*) as count FROM nodes
        WHERE properties_schema IS NOT NULL AND properties_schema != '[]'
      `).get();

      const total = db.prepare('SELECT COUNT(*) as count FROM nodes').get();
      const coverage = (withProps.count / total.count) * 100;

      console.log(`🔧 Properties extraction: ${coverage.toFixed(1)}% (${withProps.count}/${total.count})`);

      expect(coverage,
        'WARNING: Many nodes have no properties extracted. Check parser logic.'
      ).toBeGreaterThan(70); // At least 70% should have properties
    });
  });
});

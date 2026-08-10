import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { TAXONOMY_DIR } from '../src/config.js';
import { CategoryTaxonomy, CategoryKey } from '../src/schema/index.js';
import { BUNDLED_TAXONOMY } from '../src/taxonomy/bundled.js';

describe('taxonomy bundle', () => {
  it('matches the YAML source exactly, for every category the YAML defines', async () => {
    // Catches a stale bundle: forgetting to re-run `npm run build:taxonomy`
    // after editing a YAML file would otherwise ship outdated taxonomy data
    // to the extension silently.
    const files = (await fs.readdir(TAXONOMY_DIR)).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const category = path.basename(file, '.yaml') as CategoryKey;
      const raw = await fs.readFile(path.join(TAXONOMY_DIR, file), 'utf8');
      const fromYaml = CategoryTaxonomy.parse(YAML.parse(raw));
      expect(BUNDLED_TAXONOMY[category]).toEqual(fromYaml);
    }
  });

  it('has no entry for co2_incubator, the deliberate zero-shot holdout', () => {
    expect(BUNDLED_TAXONOMY.co2_incubator).toBeUndefined();
  });

  it('only contains known category keys', () => {
    for (const key of Object.keys(BUNDLED_TAXONOMY)) {
      expect(CategoryKey.safeParse(key).success).toBe(true);
    }
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toCsv } from './csv.js';

test('CSV escapes quotes, line breaks and spreadsheet formula prefixes', () => {
  const csv = toCsv(['device', 'note', 'cost'], [{ device: 'ILS-P', note: '=HYPERLINK("bad")\nnext', cost: 125.5 }, { device: '+SUM(1,2)', note: 'a"b', cost: null }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"'=HYPERLINK\(""bad""\)\nnext"/);
  assert.match(csv, /"'\+SUM\(1,2\)"/);
  assert.match(csv, /"a""b"/);
  assert.match(csv, /"125\.5"/);
});

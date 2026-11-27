"""Render actual generated report samples and check page/text bounds.

Local evidence helper only: requires PyMuPDF (fitz). The backend suite uses PDF.js.
Run from apps/api: python scripts/inspect-report-pdfs.py
"""
import hashlib
import json
from pathlib import Path

import pymupdf as fitz

samples = Path(__file__).resolve().parents[3] / 'docs' / 'pdf-samples-2026-11-27'
output = samples / 'rendered'
output.mkdir(parents=True, exist_ok=True)
names = ['health', 'incidents', 'diagnostics', 'reliability', 'preventive', 'completion',
         'expenditure', 'recommendations', 'failover', 'executive', 'empty']
manifest = []
for name in names:
    path = samples / (name + '.pdf')
    data = path.read_bytes()
    document = fitz.open(path)
    assert 1 <= document.page_count <= 80, (name, 'page budget')
    rows = []
    for index, page in enumerate(document):
        assert abs(page.rect.width - 595.28) < 1 and abs(page.rect.height - 841.89) < 1
        text = page.get_text()
        assert 'AEROPULSE' in text and f'Page {index + 1} of {document.page_count}' in text, (name, index, 'header/footer')
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    if not span['text'].strip():
                        continue
                    x0, y0, x1, y1 = span['bbox']
                    assert x0 >= 39 and x1 <= page.rect.width - 39, (name, index, 'horizontal clipping', span)
                    assert y0 >= 20 and y1 <= page.rect.height - 20, (name, index, 'vertical clipping', span)
                    if 70 < y0 < 795:
                        assert y1 <= 787, (name, index, 'body/footer overlap', span)
        # All first pages, plus every completion/recommendation page and other final pages.
        if index == 0 or index == document.page_count - 1 or name in ['completion', 'recommendations']:
            filename = f'{name}-page-{index + 1}.png'
            page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).save(output / filename)
            rows.append(filename)
    manifest.append({'file': path.name, 'pages': document.page_count, 'bytes': len(data),
                     'sha256': hashlib.sha256(data).hexdigest(), 'rendered': rows})
    print(f'PASS {path.name}: {document.page_count} pages, {len(data)} bytes; A4, header/footer and bounds')
    document.close()
(samples / 'inspection-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print('PDF_RENDER_AND_GEOMETRY_EXIT=0')

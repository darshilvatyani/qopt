from io import BytesIO
from decimal import Decimal
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ContentStream, FloatObject, NameObject
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle


ROOT = Path('/Users/darshilvatyani/Desktop/DB Project')
SOURCE = Path('/Users/darshilvatyani/Downloads/Darshil_Vatyani_resume (13).pdf')
OUTPUT = ROOT / 'output/pdf/Darshil_Vatyani_resume_qopt.pdf'
OUTPUT.parent.mkdir(parents=True, exist_ok=True)

TITLE = 'qopt - PostgreSQL Query Advisor'
BULLETS = [
    'Built a PostgreSQL query advisor that captures slow queries and diagnoses bottlenecks from execution plans.',
    'Combined rule-based checks with Gemini and hybrid documentation search to suggest indexes and SQL rewrites.',
    'Validated fixes with HypoPG and a shadow database, checking query results and execution time; rolled back experiments and sent rejection reasons to Gemini for revision.',
    'Compared four configurations on a 15-query demo workload; validation with documentation retrieval cut<br/>total execution time from <b>1,086 ms to 190 ms (5.7x faster)</b>.',
]
TOOLS = '<b>Tools Used:</b> TypeScript, Node.js, Fastify, React, PostgreSQL, Gemini API, pgvector, HypoPG'

pdfmetrics.registerFont(TTFont('ResumeTimes', '/System/Library/Fonts/Supplemental/Times New Roman.ttf'))
pdfmetrics.registerFont(TTFont('ResumeTimesBold', '/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf'))
pdfmetrics.registerFontFamily('ResumeTimes', normal='ResumeTimes', bold='ResumeTimesBold', italic='ResumeTimes', boldItalic='ResumeTimesBold')

buf = BytesIO()
canvas = Canvas(buf, pagesize=(612, 792))
canvas.setFont('ResumeTimesBold', 11.4)
canvas.drawString(45.163, 323.97, TITLE)
style = ParagraphStyle('resume', fontName='ResumeTimes', fontSize=11.25, leading=13.549, spaceAfter=0, spaceBefore=0)
y = 319.15
for text in BULLETS + [TOOLS]:
    paragraph = Paragraph(text, style)
    width, height = paragraph.wrap(538.0, 120)
    paragraph.drawOn(canvas, 45.163, y - height)
    canvas.setFont('ResumeTimes', 11.25)
    canvas.drawString(36.678, y - 11.25, '\u00b7')
    y -= height + 1.32
assert y > 212, f'Project entry overlaps Skills: {y}'
canvas.save()

reader = PdfReader(SOURCE)
writer = PdfWriter()
writer.clone_document_from_reader(reader)
page = writer.pages[0]
original = ContentStream(page.get_contents(), writer)

# This source uses one text object for the end of deja, ReviveAI and
# the Skills heading. Preserve deja and Skills, removing ReviveAI's
# text operators entirely so it cannot remain in extracted PDF text.
assert original.operations[170][1] == b'TJ'
assert 'Can' in str(original.operations[170][0])
assert 'Reviv' in str(original.operations[173][0])
assert 'SKILLS' in str(original.operations[230][0])

overlay = PdfReader(BytesIO(buf.getvalue()))
overlay_page = overlay.pages[0]
overlay_stream = ContentStream(overlay_page.get_contents(), overlay)
font_map = {}
for name, reference in overlay_page['/Resources']['/Font'].items():
    new_name = NameObject('/Qopt' + name[1:])
    page['/Resources']['/Font'][new_name] = reference.clone(writer)
    font_map[name] = new_name
for operands, operator in overlay_stream.operations:
    if operator == b'Tf':
        operands[0] = font_map[operands[0]]

skills_x = sum(Decimal(str(operands[0])) for operands, operator in original.operations[169:230] if operator == b'Td')
skills_y = sum(Decimal(str(operands[1])) for operands, operator in original.operations[169:230] if operator == b'Td')
original.operations = (
    original.operations[:171]
    + [([], b'ET'), ([], b'q')]
    + overlay_stream.operations
    + [([], b'Q'), ([], b'BT'), ([NameObject('/F52'), FloatObject(10.9091)], b'Tf'),
       ([FloatObject(skills_x), FloatObject(skills_y)], b'Td')]
    + original.operations[230:]
)
page.replace_contents(original)

annotations = page.get('/Annots', [])
page[NameObject('/Annots')] = ArrayObject([
    annotation for annotation in annotations
    if 'ReviveAI' not in str(annotation.get_object().get('/A', {}))
])
writer.add_metadata({'/Title': 'Darshil Vatyani Resume', '/Subject': 'Resume with qopt project'})
with OUTPUT.open('wb') as stream:
    writer.write(stream)

with pdfplumber.open(OUTPUT) as pdf:
    assert len(pdf.pages) == 1
    text = pdf.pages[0].extract_text()
    assert 'Revive' not in text
    for expected in ['qopt', 'HypoPG', 'hybrid documentation search', 'rejection reasons', 'four configurations', '1,086 ms', '190 ms', '5.7x faster', 'SKILLS', 'ACHIEVEMENTS']:
        assert expected in text, expected
    print(text)
assert 'Revive' not in PdfReader(OUTPUT).pages[0].extract_text()
doc = pdfium.PdfDocument(OUTPUT)
doc[0].render(scale=1.5).to_pil().save(ROOT / 'tmp/pdfs/resume-updated.png')
print('OUTPUT:', OUTPUT)

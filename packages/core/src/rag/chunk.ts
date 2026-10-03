import * as cheerio from 'cheerio';

// Splits a postgresql.org documentation page into section-aware chunks. Each chunk carries the
// heading it sits under and an anchor URL, so citations point at the exact section.

export interface RawChunk {
  title: string;
  heading: string;
  anchor?: string;
  content: string;
}

const BLOCKS = 'h1,h2,h3,h4,p,pre,table,ul,ol,dt,dd,div.note,div.tip,div.warning,div.caution,div.important,div.example';
const TARGET = 1400;
const MAX = 2000;

function clean(text: string): string {
  return text.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
}

function splitLong(text: string): string[] {
  if (text.length <= MAX) return [text];
  const parts: string[] = [];
  let cur = '';
  for (const sentence of text.split(/(?<=[.;:])\s+/)) {
    if (cur && cur.length + sentence.length > TARGET) {
      parts.push(cur);
      cur = '';
    }
    cur += (cur ? ' ' : '') + sentence;
  }
  if (cur) parts.push(cur);
  return parts.flatMap((p) => (p.length > MAX ? p.match(new RegExp(`.{1,${MAX}}`, 'gs')) ?? [] : [p]));
}

export function chunkDocPage(html: string): RawChunk[] {
  const $ = cheerio.load(html);
  const root = $('#docContent').length ? $('#docContent') : $('body');
  root.find('.navheader, .navfooter, a.id_link, a.indexterm, script, style').remove();

  const title = clean(root.find('h1, h2').first().text());
  const chunks: RawChunk[] = [];
  let heading = title;
  let anchor: string | undefined;
  let buf: string[] = [];

  const flush = () => {
    const content = buf.join('\n').trim();
    buf = [];
    if (content.length < 80) return;
    for (const piece of splitLong(content)) chunks.push({ title, heading, anchor, content: piece });
  };

  root.find(BLOCKS).each((_, el) => {
    const $el = $(el);
    // Leaf blocks only: skip anything nested inside another block we already take whole.
    if ($el.parents(BLOCKS).length) return;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-4]$/.test(tag)) {
      flush();
      heading = clean($el.text());
      anchor = $el.closest('[id]').attr('id') ?? anchor;
      return;
    }
    let text: string;
    if (tag === 'pre') text = $el.text().trim();
    else if (tag === 'table') {
      // Long reference tables (operator class listings, catalog columns) drown out prose in retrieval.
      if ($el.find('tr').length > 15) return;
      text = $el
        .find('tr')
        .map((_, tr) =>
          $(tr)
            .find('th,td')
            .map((_, c) => clean($(c).text()))
            .get()
            .join(' | '),
        )
        .get()
        .join('\n');
    } else if (tag === 'dt') text = `• ${clean($el.text())}`;
    else text = clean($el.text());
    if (!text) return;
    if (buf.join('\n').length + text.length > TARGET && buf.length) flush();
    buf.push(text);
  });
  flush();
  return chunks;
}

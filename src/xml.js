// A small XML reader for Yahoo's Fantasy API responses. Yahoo's XML is
// plain elements and text (no mixed content we care about), so this keeps
// elements, text and attributes and skips everything else.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e] ?? m;
});

export function parseXml(xml) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) {
      top.text += m[1];
    } else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const node = { tag: m[3].replace(/^.*:/, ''), attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] != null) {
      top.text += decode(m[6]);
    }
  }
  return root;
}

// child(node, 'a/b/c') -> first matching descendant along the path
export function child(node, path) {
  let cur = node;
  for (const tag of path.split('/')) {
    cur = cur?.children.find((c) => c.tag === tag);
    if (!cur) return null;
  }
  return cur;
}

// children(node, 'a/b') -> all 'b' elements under the first 'a'
export function children(node, path) {
  const parts = path.split('/');
  const last = parts.pop();
  const parent = parts.length ? child(node, parts.join('/')) : node;
  return parent ? parent.children.filter((c) => c.tag === last) : [];
}

// text(node, 'a/b') -> trimmed text, or null when missing
export function text(node, path) {
  const n = path ? child(node, path) : node;
  const t = n?.text?.trim();
  return t === undefined || t === '' ? (n ? '' : null) : t;
}

export const num = (node, path) => {
  const t = text(node, path);
  return t === null || t === '' ? null : Number(t);
};

// Depth-first search for every element with this tag.
export function findAll(node, tag, out = []) {
  for (const c of node.children) {
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}

/**
 * Minimal YAML subset parser — enough for the demo policy catalog
 * (nested maps, lists of maps, scalars, quoted strings). Deliberately tiny
 * and dependency-free; stricter parsing is not needed for this controlled file.
 */

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

function preprocess(src: string): Line[] {
  const lines: Line[] = [];
  for (const raw of src.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, text: raw.trim() });
  }
  return lines;
}

function scalar(s: string): YamlValue {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

/** Parse block starting at index i with given indent; returns [value, nextIndex]. */
function parseBlock(lines: Line[], i: number, indent: number): [YamlValue, number] {
  if (i >= lines.length) return [null, i];

  // List block
  if (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-') {
    const arr: YamlValue[] = [];
    while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-')) {
      const first = lines[i]!.text.slice(2).trim();
      if (first === '') {
        i += 1;
        const [v, ni] = parseBlock(lines, i, lines[i]?.indent ?? indent + 2);
        arr.push(v);
        i = ni;
      } else if (first.includes(':')) {
        // inline first key of a map item; synthesize a line at deeper indent
        const itemIndent = indent + 2;
        const sub: Line[] = [{ indent: itemIndent, text: first }];
        i += 1;
        while (i < lines.length && lines[i]!.indent > indent) {
          sub.push(lines[i]!);
          i += 1;
        }
        const [v] = parseBlock(sub, 0, itemIndent);
        arr.push(v);
      } else {
        arr.push(scalar(first));
        i += 1;
      }
    }
    return [arr, i];
  }

  // Map block
  const map: { [k: string]: YamlValue } = {};
  while (i < lines.length && lines[i]!.indent === indent) {
    const text = lines[i]!.text;
    const ci = text.indexOf(':');
    if (ci === -1) break;
    const key = text.slice(0, ci).trim();
    const rest = text.slice(ci + 1).trim();
    i += 1;
    if (rest === '') {
      if (i < lines.length && lines[i]!.indent > indent) {
        const [v, ni] = parseBlock(lines, i, lines[i]!.indent);
        map[key] = v;
        i = ni;
      } else {
        map[key] = null;
      }
    } else {
      map[key] = scalar(rest);
    }
  }
  return [map, i];
}

export function parseYaml(src: string): YamlValue {
  const lines = preprocess(src);
  const [v] = parseBlock(lines, 0, lines[0]?.indent ?? 0);
  return v;
}

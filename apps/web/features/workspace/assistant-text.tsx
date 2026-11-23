import type { ReactNode } from 'react';

const inline = /(`+[^`\n]+`+)|(\[([^\]\n]+)\]\(([^)\s]+)\))|(\*\*([^*\n]+)\*\*|__([^_\n]+)__)|(\*([^*\n]+)\*|\b_([^_\n]+)_\b)/g;
const heading = /^ {0,3}(#{1,6})[ \t]+(.+)$/;
const bullet = /^ {0,3}[-+*][ \t]+(.+)$/;
const ordered = /^ {0,3}(\d{1,9})[.)][ \t]+(.+)$/;
const fence = /^ {0,3}(`{3,}|~{3,})[^\s`~]*\s*$/;

function safeLink(destination: string) {
  if (!/^https?:\/\//i.test(destination) || /[\s\u0000-\u001f\u007f\\]/.test(destination)) return null;
  try {
    const url = new URL(destination);
    return url.username || url.password ? null : url.href;
  } catch {
    return null;
  }
}

function emphasis(value: string, allowLinks = true): ReactNode[] {
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(inline)) {
    const [token, code, link, label, destination, , strong, altStrong, , italic, altItalic] = match;
    const at = match.index;
    nodes.push(value.slice(offset, at));
    if (code) nodes.push(<code key={at}>{code.replace(/^`+|`+$/g, '')}</code>);
    else if (link) {
      const href = allowLinks && destination ? safeLink(destination) : null;
      nodes.push(href && label ? <a key={at} href={href} rel="noreferrer">{emphasis(label, false)}</a> : token);
    } else if (strong || altStrong) nodes.push(<strong key={at}>{strong || altStrong}</strong>);
    else nodes.push(<em key={at}>{italic || altItalic}</em>);
    offset = at + token.length;
  }
  nodes.push(value.slice(offset));
  return nodes;
}

/** Render a limited Markdown dialect as React nodes. All model text, including HTML-looking text, is escaped by React. */
export function AssistantText({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const key = i;
    const line = lines[i++] ?? '';
    if (!line.trim()) continue;
    const opening = fence.exec(line)?.[1];
    if (opening) {
      const closing = new RegExp('^ {0,3}' + opening[0] + '{' + opening.length + ',}\\s*$');
      const body: string[] = [];
      while (i < lines.length && !closing.test(lines[i] ?? '')) body.push(lines[i++] ?? '');
      i++;
      blocks.push(<pre key={key} tabIndex={0} role="region" aria-label="Code block"><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const title = heading.exec(line);
    if (title?.[1] && title[2]) {
      const Heading = title[1].length === 1 ? 'h3' : title[1].length === 2 ? 'h4' : title[1].length === 3 ? 'h5' : 'h6';
      blocks.push(<Heading key={key}>{emphasis(title[2])}</Heading>);
      continue;
    }
    const listPattern = ordered.test(line) ? ordered : bullet;
    const first = listPattern.exec(line);
    if (first) {
      const entries = [first.at(-1) ?? ''];
      for (let next = listPattern.exec(lines[i] ?? ''); next; next = listPattern.exec(lines[i] ?? '')) {
        entries.push(next.at(-1) ?? '');
        i++;
      }
      const items = entries.map((entry, index) => <li key={index}>{emphasis(entry)}</li>);
      blocks.push(listPattern === ordered ? <ol key={key} start={Number(first[1])}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    const paragraph = [line];
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (!next.trim() || [heading, bullet, ordered, fence].some(pattern => pattern.test(next))) break;
      paragraph.push(next);
      i++;
    }
    blocks.push(<p key={key}>{emphasis(paragraph.join('\n'))}</p>);
  }
  return <>{blocks}</>;
}

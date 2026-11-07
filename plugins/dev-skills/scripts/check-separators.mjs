import { fromMarkdown } from 'mdast-util-from-markdown';

const separator = /^ {0,3}(?:(?:-[\t ]*){3,}|(?:\*[\t ]*){3,}|(?:_[\t ]*){3,})$/;
const blank = /^[\t ]*$/;

export function offendingLines(markdown) {
  // Let the Markdown parser handle fences, tabs and nested containers. Keep the
  // publication rule's existing column-zero spelling/indentation policy.
  const codeLines = new Set();
  const pending = [fromMarkdown(markdown)];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'code') {
      for (let line = node.position.start.line; line <= node.position.end.line; line++) {
        codeLines.add(line);
      }
    }
    if (node.children) pending.push(...node.children);
  }

  const lines = markdown.split(/\r\n|\n|\r/);
  return lines.flatMap((line, index) =>
    index > 0 && !codeLines.has(index + 1) &&
    separator.test(line) && !blank.test(lines[index - 1]) ? [index + 1] : []);
}

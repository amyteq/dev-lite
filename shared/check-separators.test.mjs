import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offendingLines } from './check-separators.mjs';

const cases = [
  ['AC2: tab content in list fence', '- ```\n\tx\n  ---\n  ```\n', []],
  ['tab-only line in list fence', '- ```\n\t\n  ---\n  ```\n', []],
  ['mixed indentation in list fence', '- ```\n \tx\n  ---\n  ```\n', []],
  ['nested list and tilde fence', '- item\n  - ~~~text\n\tcode\n    ---\n    ~~~\n', []],
  ['fence on a list continuation', '- item\n\n  ```\n  x\n  ---\n  ```\n', []],
  ['dedent out of list fence exposes real defect', '- item\n\n  ```\n  x\nParagraph\n---\n', [6]],
  ['unbalanced container fences preserve later code', '- - ```\n  ```\n```\nx\n---\n```\n', []],
  ['quoted fence cannot close outer fence', '```\n> ```\nx\n---\n```\n', []],
  ['shorter fence cannot close wider fence', '````\n```\nx\n---\n````\n', []],
  ['opposite delimiter cannot close fence', '~~~\n```\nx\n---\n~~~\n', []],
  ['info string cannot close fence', '```\n```js\nx\n---\n```\n', []],
  ['unclosed fence extends to EOF', '```js\nx\n---\n', []],
  ['backtick info containing backtick is not opener', '```a`b\ntext\n---\n', [3]],
  ['blank line fixes original assembled signature defect', 'Scope proposals: none.\n\n---\nSignature\n', []],
  ['assembled signature defect', 'Scope proposals: none.\n---\nSignature\n', [2]],
  ['separator after closing fence still requires blank', '```\ntext\n```\n---\n', [4]],
  ['separator after list still requires blank', '- item\n***\n', [2]],
  ['all marker spellings and original line numbers', 'a\n- - -\n\nb\n  * * *\n\nc\n   ____\n', [2, 5, 8]],
  ['whitespace-only predecessor is blank', 'a\n \t\n---\n', []],
  ['first-line separator and empty input', '---\n', []],
  ['empty body', '', []],
  ['existing quoted/list-relative/short-underline exclusions', '> Paragraph\n> ---\n\n- item\n    ---\n\nParagraph\n--\n', []],
];

for (const [name, markdown, expected] of cases) {
  test(name, () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      assert.deepEqual(offendingLines(markdown.replaceAll('\n', newline)), expected);
    }
  });
}

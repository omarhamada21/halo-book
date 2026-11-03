// Rebuilds a page's full source as it was before the CSS/JS were moved out of the HTML:
// each <link href="/assets/css/..."> and local <script src="/assets/js/..."> tag is replaced
// by the file's contents inlined back into <style>/<script> blocks.
// Used by tests that inspect the page source (DOM ids, CSS selectors, script syntax).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

export function loadPage(pageName) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, pageName), 'utf8');
  html = html.replace(/^([ \t]*)<link rel="stylesheet" href="\/assets\/css\/([^"]+)">$/gm, (_, indent, file) =>
    `${indent}<style>\n${fs.readFileSync(path.join(PUBLIC_DIR, 'assets', 'css', file), 'utf8')}${indent}</style>`);
  html = html.replace(/^([ \t]*)<script src="\/assets\/js\/([^"]+)"><\/script>$/gm, (_, indent, file) =>
    `${indent}<script>\n${fs.readFileSync(path.join(PUBLIC_DIR, 'assets', 'js', file), 'utf8')}${indent}</script>`);
  return html;
}

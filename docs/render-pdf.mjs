import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node render.mjs <input.html> <output.pdf>');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();

await page.goto(pathToFileURL(path.resolve(input)).href, { waitUntil: 'networkidle' });
await page.emulateMedia({ media: 'print' });

const footer = `
<div style="width:100%;font-family:'Segoe UI',sans-serif;font-size:7.5pt;color:#8a938f;
            padding:0 17mm;display:flex;justify-content:space-between;align-items:center;">
  <span>Astro Website QA &mdash; Implementation Guide</span>
  <span class="pageNumber"></span>
</div>`;

await page.pdf({
  path: path.resolve(output),
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: footer,
  margin: { top: '16mm', bottom: '14mm', left: '17mm', right: '17mm' },
});

await browser.close();
console.log(`wrote ${output}`);

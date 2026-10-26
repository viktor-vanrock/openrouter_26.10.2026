/** Render the self-contained local deployment guide. No application/network credentials. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const directory = path.dirname(fileURLToPath(import.meta.url));
const pdf = path.join(directory, 'prototype-service-deployment-guide-2026-10-12.pdf');
const evidence = path.resolve(directory, '../../../../.prototype-dev/deployment-guide-2026-10-12');
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1220 }, deviceScaleFactor: 1 });
  await page.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort());
  await page.goto(pathToFileURL(path.join(directory, 'guide.html')).href);
  await page.evaluate(() => document.fonts.ready);
  const fit = await page.locator('.page').evaluateAll(pages => pages.map((p, i) => {
    const rect = p.getBoundingClientRect(), footer = p.querySelector('.footer').getBoundingClientRect();
    const children = [...p.children].filter(x => !x.classList.contains('footer'));
    return { page: i + 1, contentBottom: Math.max(...children.map(x => x.getBoundingClientRect().bottom)) - rect.top,
      footerTop: footer.top - rect.top, height: rect.height, overflow: p.scrollHeight > p.clientHeight };
  }));
  await fs.writeFile(path.join(evidence, 'layout.json'), JSON.stringify(fit, null, 2), { mode: 0o600 });
  if (fit.some(p => p.overflow || p.contentBottom + 10 > p.footerTop)) throw new Error('GUIDE_PAGE_OVERFLOW: ' + JSON.stringify(fit));
  for (let i = 0; i < fit.length; i++) await page.locator('.page').nth(i).screenshot({ path: path.join(evidence, `page-${i + 1}.png`) });
  await page.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true, tagged: true });
  console.log(JSON.stringify({ pdf, pages: fit.length, layout: 'PASS', evidenceDirectory: evidence }));
} finally { await browser.close(); }

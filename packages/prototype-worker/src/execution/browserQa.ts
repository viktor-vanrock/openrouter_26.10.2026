export type BrowserQaResult = {
  checks: string[];
  consoleErrors: string[];
  networkRequests: string[];
};

type BrowserModule = {
  chromium: {
    launch(options: { headless: true; chromiumSandbox: true }): Promise<any>;
  };
};

export class PlaywrightBrowserQa {
  constructor(
    private readonly loadBrowser: () => Promise<BrowserModule> = async () => import('@playwright/test') as unknown as BrowserModule,
  ) {}

  async run(input: { html: Buffer; timeoutMs?: number }): Promise<BrowserQaResult> {
    const timeoutMs = input.timeoutMs ?? 10_000;
    const errors: string[] = [];
    const networkRequests: string[] = [];
    const checks: string[] = [];
    const { chromium } = await this.loadBrowser();
    // Intentionally do not pass --no-sandbox or disable Chromium's process sandbox.
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    try {
      for (const [viewportName, viewport] of [
        ['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }],
      ] as const) {
        const page = await browser.newPage({ viewport });
        page.setDefaultTimeout?.(3_000);
        checks.push(viewportName);
        page.on('pageerror', (error: Error) => errors.push(error.message));
        page.on('console', (message: any) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.route('**/*', async (route: any) => {
          const url = route.request().url();
          if (url === 'http://prototype-preview.test/') {
            await route.fulfill({
              contentType: 'text/html',
              body: '<!doctype html><meta charset="utf-8"><iframe sandbox="allow-scripts allow-forms" title="Accepted prototype" style="width:100vw;height:100vh;border:0"></iframe>',
            });
            return;
          }
          if (url.startsWith('blob:') || url.startsWith('data:')) {
            await route.continue();
            return;
          }
          networkRequests.push(url.slice(0, 512));
          await route.abort('blockedbyclient');
        });
        await page.goto('http://prototype-preview.test/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.evaluate((html: string) => {
          const iframe = document.querySelector('iframe');
          if (!(iframe instanceof HTMLIFrameElement)) throw new Error('Preview iframe is missing');
          // Match ChatRouter Preview's parsing, policy and srcdoc delivery, including opaque origin.
          const documentNode = new DOMParser().parseFromString(html, 'text/html');
          const policy = documentNode.createElement('meta');
          policy.httpEquiv = 'Content-Security-Policy';
          policy.content = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'";
          documentNode.head.prepend(policy);
          iframe.srcdoc = '<!doctype html>' + documentNode.documentElement.outerHTML;
        }, input.html.toString('utf8'));
        try {
          const frame = page.frameLocator('iframe');
          checks.push('preview-iframe');
          try { await frame.locator('body').waitFor({ state: 'visible', timeout: timeoutMs }); }
          catch { errors.push(`Preview did not render (${viewportName})`); await page.close?.(); continue; }
          await page.waitForTimeout(500);
          const text = (await frame.locator('body').innerText()).trim();
          if (!text) errors.push('Preview is blank');
          else checks.push('meaningful-body');
          if (text.includes('Прототип готов к разработке')) errors.push('Preview contains the unchanged template');
          const root = frame.locator('#root');
          if (await root.count()) {
            const rootChildren = root.locator(':scope > *');
            if (await rootChildren.count()) await rootChildren.first().waitFor({ state: 'visible', timeout: timeoutMs });
            else errors.push(`React root is empty (${viewportName})`);
            if (await rootChildren.count()) checks.push('root-rendered');
          }
          const controls = frame.locator('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]');
          const controlCount = await controls.count();
          checks.push(`controls:${controlCount}`);
          let trigger = frame.getByRole('button', { name: /add|create|добав|созд/i }).first();
          if (!(await trigger.count())) trigger = frame.getByRole('button', { name: /open|edit|menu|откры|редакт|меню/i }).first();
          if (await trigger.count()) {
            await trigger.evaluate((element: Element) => element.setAttribute('data-prototype-qa-trigger', 'true'));
            const before = await trigger.evaluate((element: Element) => ({
              expanded: element.getAttribute('aria-expanded'),
              pressed: element.getAttribute('aria-pressed'),
              state: element.getAttribute('data-state'),
            }));
            const dialogsBefore = await frame.getByRole('dialog').count();
            const visibleTextBefore = await frame.locator('body').innerText();
            await trigger.click({ timeout: 3_000 });
            await page.waitForTimeout(100);
            const markedTrigger = frame.locator('[data-prototype-qa-trigger="true"]');
            const after = await markedTrigger.count() ? await markedTrigger.first().evaluate((element: Element) => ({
              expanded: element.getAttribute('aria-expanded'),
              pressed: element.getAttribute('aria-pressed'),
              state: element.getAttribute('data-state'),
            })) : null;
            const dialogsAfter = await frame.getByRole('dialog').count();
            const visibleTextAfter = await frame.locator('body').innerText();
            if (JSON.stringify(before) === JSON.stringify(after) && dialogsAfter <= dialogsBefore &&
                visibleTextBefore === visibleTextAfter) {
              errors.push('Primary interaction produced no observable state change');
            } else checks.push('primary-interaction');
          }
        } catch (error) {
          // A mounted app with an unclickable/hidden control is a source QA failure,
          // distinct from launch or browser process failures that require infrastructure repair.
          if ((error as Error).name !== 'TimeoutError') throw error;
          errors.push(`Preview render or interaction timed out (${viewportName})`);
        }
        await page.close?.();
      }
      return { checks: [...new Set(checks)], consoleErrors: errors.slice(0, 50), networkRequests: networkRequests.slice(0, 50) };
    } finally {
      await browser.close();
    }
  }
}

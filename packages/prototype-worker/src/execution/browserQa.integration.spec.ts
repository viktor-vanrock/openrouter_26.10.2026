import { PlaywrightBrowserQa } from './browserQa';

const integrationDescribe = process.env.PROTOTYPE_BROWSER_QA_INTEGRATION === '1'
  ? describe
  : describe.skip;

integrationDescribe('PlaywrightBrowserQa real Chromium', () => {
  it('catches startup failure in an opaque srcdoc iframe despite valid static HTML', async () => {
    const qa = await new PlaywrightBrowserQa().run({ html: Buffer.from('<!doctype html><div id="root"></div><script>throw new Error("startup-failure-fixture")</script>'), timeoutMs: 1500 });
    expect(qa.consoleErrors.join('\n')).toMatch(/startup-failure-fixture|did not render|blank/);
  }, 10000);
  it('matches Preview CSP and rejects code that depends on localStorage in the opaque frame', async () => {
    const qa = await new PlaywrightBrowserQa().run({ html: Buffer.from('<!doctype html><main>Mounted</main><script>localStorage.getItem("fixture")</script>'), timeoutMs: 1500 });
    expect(qa.consoleErrors.length).toBeGreaterThan(0);
    expect(qa.checks).toEqual(expect.arrayContaining(['preview-iframe', 'desktop', 'mobile']));
  }, 10000);
  it('allows local submit handlers to mutate data while CSP still blocks outbound forms', async () => {
    const html = Buffer.from(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; form-action 'none'">
      <main>Editable employee: <output id="value">Before</output></main>
      <button onclick="document.getElementById('editor').hidden=false">Редактировать</button>
      <form id="editor" onsubmit="event.preventDefault();document.getElementById('value').textContent=document.getElementById('name').value">
        <input id="name" value="After"><button type="submit">Добавить</button>
      </form>`);
    const qa = await new PlaywrightBrowserQa().run({ html });
    expect(qa.checks).toContain('primary-interaction');
    expect(qa.consoleErrors).toEqual([]);
    expect(qa.networkRequests).toEqual([]);
  }, 20_000);
  it('renders a single-file preview and proves a primary interaction without network access', async () => {
    const html = Buffer.from(`<!doctype html>
      <div id="root">
        <main>Offline prototype</main>
        <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('[role=dialog]').hidden=false">Open dialog</button>
        <section role="dialog" hidden>Created dialog</section>
      </div>`);
    const result = await new PlaywrightBrowserQa().run({ html, timeoutMs: 10_000 });
    expect(result).toEqual({
      checks: expect.arrayContaining(['meaningful-body', 'root-rendered', 'primary-interaction']),
      consoleErrors: [],
      networkRequests: [],
    });
  }, 20_000);

  it('records and blocks external requests from generated HTML', async () => {
    const html = Buffer.from(`<!doctype html><div id="root">Network attempt</div>
      <script>fetch('https://example.test/private').catch(() => undefined)</script>`);
    const result = await new PlaywrightBrowserQa().run({ html, timeoutMs: 10_000 });
    // Preview CSP can reject the request before Playwright's network interception sees it.
    expect([...result.networkRequests, ...result.consoleErrors].join('\n')).toMatch(/example\.test|Content Security Policy|connect-src/i);
  }, 20_000);
});

integrationDescribe('primary interaction without ARIA annotations', () => {
  it('reports a blocked primary control as source QA rather than a browser infrastructure exception', async () => {
    const qa = await new PlaywrightBrowserQa().run({ html: Buffer.from('<!doctype html><main>Employees</main><button style="pointer-events:none">Добавить сотрудника</button>') });
    expect(qa.consoleErrors.join('\n')).toMatch(/interaction timed out/);
  }, 20_000);
  it('accepts a visible modal whose content changes without role=dialog or aria-expanded', async () => {
    const html = Buffer.from(`<!doctype html><main>Employees</main>
      <button onclick="document.getElementById('editor').hidden=false">Добавить сотрудника</button>
      <section id="editor" hidden><label>Employee name<input></label><button>Сохранить</button></section>`);
    const qa = await new PlaywrightBrowserQa().run({ html });
    expect(qa.checks).toContain('primary-interaction');
    expect(qa.consoleErrors).toEqual([]);
  }, 20_000);
  it('still rejects a button with no observable effect', async () => {
    const qa = await new PlaywrightBrowserQa().run({ html: Buffer.from('<!doctype html><main>Employees</main><button>Добавить сотрудника</button>') });
    expect(qa.consoleErrors).toContain('Primary interaction produced no observable state change');
  }, 20_000);
});

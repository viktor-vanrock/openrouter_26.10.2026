import { PlaywrightBrowserQa } from './browserQa';

describe('PlaywrightBrowserQa', () => {
  it('launches headless Chromium without disabling its sandbox', async () => {
    const launch = jest.fn(async () => ({
      newPage: async () => ({
        on: jest.fn(), route: jest.fn(), goto: jest.fn(), evaluate: jest.fn(), waitForTimeout: jest.fn(),
        frameLocator: () => ({
          locator: (selector: string) => selector === 'body'
            ? { waitFor: jest.fn(), innerText: async () => 'Rendered prototype' }
            : selector === '#root'
              ? { count: async () => 0 }
              : { count: async () => 0 },
          getByRole: () => ({ first: () => ({ count: async () => 0 }) }),
        }),
      }),
      close: jest.fn(),
    }));
    const qa = new PlaywrightBrowserQa(async () => ({ chromium: { launch } }));
    await expect(qa.run({ html: Buffer.from('<main>Rendered prototype</main>') })).resolves.toMatchObject({
      consoleErrors: [], networkRequests: [],
    });
    expect(launch).toHaveBeenCalledWith({ headless: true, chromiumSandbox: true });
    expect(JSON.stringify(launch.mock.calls)).not.toContain('--no-sandbox');
  });
});

const { sanitizeGuideHtml, validateRawHtml } = require('./sanitizeGuideHtml');

describe('sanitizeGuideHtml', () => {
  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">bad</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x"></object>',
    '<embed src="x">',
    '<form action="https://evil.example"><input></form>',
    '<base href="https://evil.example">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<svg onload="alert(1)"></svg>',
    '<img src="data:text/html;base64,PHNjcmlwdD4=">',
  ])('removes dangerous markup: %s', (html) => {
    const output = sanitizeGuideHtml(html);
    expect(output).not.toMatch(
      /<script|onerror|javascript:|<iframe|<object|<embed|<form|<base|<link|<meta|<svg|data:text\/html/i,
    );
  });

  it('keeps safe styles while removing imports and external CSS URLs', () => {
    const output = sanitizeGuideHtml(
      '<style>@import url(https://evil.example/x.css); .a { color: red; background: url(https://evil.example/p.png) }</style><div style="background:url(https://evil.example/p.png)">ok</div>',
    );
    expect(output).toContain('<style>.a { color: red; background: none }</style>');
    expect(output).not.toMatch(/@import|evil\.example/);
  });

  it('keeps tables and valid data images', () => {
    const output = sanitizeGuideHtml(
      '<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table><img src="data:image/png;base64,aGVsbG8=">',
    );
    expect(output).toContain('<table>');
    expect(output).toContain('data:image/png;base64,aGVsbG8=');
  });

  it('keeps only valid guide media markers and removes unsafe media attributes', () => {
    const id = '0123456789abcdef01234567';
    const output = sanitizeGuideHtml(
      `<img src="media/${id}"><video autoplay onerror="alert(1)" src="media/${id}" poster="https://evil.example/p.png"></video><source src="https://evil.example/v.mp4"><img src="media/../../x"><video src="https://evil.example/v.mp4"></video>`,
    );
    expect(output).toContain(`<img src="media/${id}" />`);
    expect(output).toContain(`<video src="media/${id}"></video>`);
    expect(output).not.toMatch(/autoplay|onerror|evil\.example|media\/\.\.\/\.\.\/x/);
  });

  it('validates raw HTML before storage', () => {
    expect(validateRawHtml('not html')).toBe('Файл не похож на HTML');
    expect(validateRawHtml('<p>ok</p>')).toBeNull();
  });
});

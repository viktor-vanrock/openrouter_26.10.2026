import { resolveMedia } from './utils';

describe('resolveMedia', () => {
  const id = '0123456789abcdef01234567';

  it('replaces only src and poster attributes and escapes signed URLs', () => {
    const output = resolveMedia(
      `<img src="media/${id}"><video poster='media/${id}'></video><p>media/${id}</p>`,
      { [id]: { url: 'https://media.example/file?x=1&signature="x"' } },
    );
    expect(output).toContain('src="https://media.example/file?x=1&amp;signature=&quot;x&quot;"');
    expect(output).toContain("poster='https://media.example/file?x=1&amp;signature=&quot;x&quot;'");
    expect(output).toContain(`<p>media/${id}</p>`);
  });

  it('leaves unknown markers untouched', () => {
    expect(resolveMedia(`<img src="media/${id}">`)).toContain(`media/${id}`);
  });
});

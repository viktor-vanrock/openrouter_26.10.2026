import { imageModeAvailability } from './imageModeAvailability';

const base = { developing: true, endpoint: 'OpenRouter', model: 'example/model' };

describe('imageModeAvailability', () => {
  it('treats absent metadata or parameters as unsupported', () => {
    expect(imageModeAvailability(base).eligible).toBe(true);
    expect(imageModeAvailability({ ...base, metadata: { id: base.model } }).eligible).toBe(true);
  });

  it('excludes models with tools or image output', () => {
    expect(
      imageModeAvailability({
        ...base,
        metadata: { id: base.model, supported_parameters: ['tools'] },
      }).eligible,
    ).toBe(false);
    expect(
      imageModeAvailability({ ...base, metadata: { id: base.model, output_modalities: ['image'] } })
        .eligible,
    ).toBe(false);
  });

  it('requires the developing cookie and OpenRouter', () => {
    expect(imageModeAvailability({ ...base, developing: false }).eligible).toBe(false);
    expect(imageModeAvailability({ ...base, endpoint: 'other' }).eligible).toBe(false);
  });

  it('recognizes image output declared inside architecture', () => {
    expect(
      imageModeAvailability({
        ...base,
        metadata: {
          id: base.model,
          architecture: { output_modalities: ['text', 'image'] },
        },
      }).eligible,
    ).toBe(false);
  });
});

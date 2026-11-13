import { createPayload } from 'librechat-data-provider';
import type { TSubmission } from 'librechat-data-provider';

it('places the direct flag only on the selected submission payload', () => {
  const submission = {
    conversation: { endpoint: 'OpenRouter', conversationId: 'new' },
    endpointOption: { endpoint: 'OpenRouter' },
    userMessage: { text: 'кот' },
    ephemeralAgent: { web_search: true },
    isTemporary: false,
  } as unknown as TSubmission;
  const direct = createPayload({ ...submission, image_generation_direct: true }).payload;
  const ordinary = createPayload(submission).payload;
  expect(direct.image_generation_direct).toBe(true);
  expect(direct.ephemeralAgent).toEqual({ web_search: true });
  expect(ordinary.image_generation_direct).toBeUndefined();
  expect(ordinary.ephemeralAgent).toEqual({ web_search: true });
});

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('@librechat/agents', () => ({
  Calculator: class Calculator {},
}));
jest.mock('@librechat/agents/langchain/tools', () => ({
  Tool: class Tool {},
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}));
jest.mock('librechat-data-provider', () => ({
  Tools: { function: 'function' },
  ImageVisionTool: { type: 'function', function: { name: 'image_vision' } },
}));
jest.mock('@librechat/api', () => ({
  getToolkitKey: jest.fn(),
  oaiToolkit: {},
  geminiToolkit: {},
}));
jest.mock('~/app/clients/tools/manifest', () => ({ toolkits: {} }));

const { logger } = require('@librechat/data-schemas');
const { loadAndFormatTools } = require('./tools');

describe('loadAndFormatTools', () => {
  it('does not execute colocated spec or test files during application startup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-tools-'));
    try {
      fs.writeFileSync(path.join(directory, 'Example.spec.js'), 'throw new Error("loaded spec")');
      fs.writeFileSync(path.join(directory, 'Example.test.js'), 'throw new Error("loaded test")');

      expect(() => loadAndFormatTools({ directory })).not.toThrow();
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

/** Preserve OpenRouter's image output until the message completion handler can save it. */
function enableOpenRouterImageStream(ChatOpenAICompletions) {
  const prototype = ChatOpenAICompletions.prototype;
  const key = Symbol.for('librechat.openrouterImageStream');
  if (prototype[key]) return;
  const original = prototype._convertCompletionsDeltaToBaseMessageChunk;
  if (typeof original !== 'function') throw new Error('OpenAI streaming converter is unavailable');
  prototype._convertCompletionsDeltaToBaseMessageChunk = function (delta, ...args) {
    const chunk = original.call(this, delta, ...args);
    if (Array.isArray(delta.images) && delta.images.length && chunk?.additional_kwargs) {
      chunk.additional_kwargs.openrouter_images = delta.images;
    }
    return chunk;
  };
  Object.defineProperty(prototype, key, { value: true });
}
module.exports = { enableOpenRouterImageStream };

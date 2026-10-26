class PrototypeServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PrototypeServiceError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

module.exports = { PrototypeServiceError };

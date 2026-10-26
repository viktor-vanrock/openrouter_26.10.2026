const { PrototypeServiceError } = require('./errors');

function requirePrototypeEnabled(req, isAvailable) {
  if (req?.config?.prototypeAgent?.enabled !== true || (isAvailable && isAvailable() !== true)) {
    throw new PrototypeServiceError(
      'PROTOTYPE_SERVICE_UNAVAILABLE',
      'Prototype service is unavailable',
    );
  }
}

module.exports = { requirePrototypeEnabled };

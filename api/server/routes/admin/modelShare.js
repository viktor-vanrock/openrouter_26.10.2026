const express = require('express');
const mongoose = require('mongoose');
const { createAdminModelShareHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

const handlers = createAdminModelShareHandlers({
  aggregate: (pipeline) => {
    const Message = mongoose.models.Message;
    if (!Message) {
      throw new Error('Message model not available');
    }
    return Message.aggregate(pipeline);
  },
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', handlers.getModelShare);

module.exports = router;

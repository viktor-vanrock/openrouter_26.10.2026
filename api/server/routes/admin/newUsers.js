const express = require('express');
const mongoose = require('mongoose');
const { createAdminNewUsersHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

const handlers = createAdminNewUsersHandlers({
  aggregate: (pipeline) => {
    const User = mongoose.models.User;
    if (!User) {
      throw new Error('User model not available');
    }
    return User.aggregate(pipeline);
  },
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', handlers.getNewUsers);

module.exports = router;

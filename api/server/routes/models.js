const express = require('express');
const {
  modelController,
  modelCapabilitiesController,
} = require('~/server/controllers/ModelController');
const { requireJwtAuth } = require('~/server/middleware/');

const router = express.Router();
router.get('/', requireJwtAuth, modelController);
router.get('/capabilities', requireJwtAuth, modelCapabilitiesController);

module.exports = router;

const express = require('express');
const bcrypt = require('bcryptjs');
const { webcrypto } = require('node:crypto');
const { createAdminUsersHandlers, checkEmailConfig } = require('@librechat/api');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { getUserById, createToken, deleteTokens } = require('~/models');
const { sendEmail } = require('~/server/utils');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);
const requireManageUsers = requireCapability(SystemCapabilities.MANAGE_USERS);

const handlers = createAdminUsersHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  updateUser: db.updateUser,
  deleteUserById: db.deleteUserById,
  deleteConfig: db.deleteConfig,
  deleteAclEntries: db.deleteAclEntries,
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', requireReadUsers, handlers.listUsers);
router.get('/search', requireReadUsers, handlers.searchUsers);

router.patch('/:id/role', requireManageUsers, handlers.updateUserRole);
// router.delete('/:id', requireManageUsers, handlers.deleteUser);

router.post('/:id/reset-password', requireManageUsers, async (req, res) => {
  try {
    const user = await getUserById(req.params.id, 'email name username _id');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    await deleteTokens({ userId: user._id });

    const resetToken = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex');
    const hash = bcrypt.hashSync(resetToken, 10);

    await createToken({
      userId: user._id,
      token: hash,
      createdAt: Date.now(),
      expiresIn: 900,
    });

    const clientDomain = process.env.DOMAIN_CLIENT ||
    (req.headers.origin ?? `${req.protocol}://${req.get('host')}`);
    const link = `${clientDomain}/reset-password?token=${resetToken}&userId=${user._id}`;

    const emailEnabled = checkEmailConfig();
    if (emailEnabled) {
      await sendEmail({
        email: user.email,
        subject: 'Password Reset Request',
        payload: {
          appName: process.env.APP_TITLE || 'LibreChat',
          name: user.name || user.username || user.email,
          link,
          year: new Date().getFullYear(),
        },
        template: 'requestPasswordReset.handlebars',
      });
      logger.info(`[admin/reset-password] Link emailed. [Email: ${user.email}] [ID: ${user._id}]`);
      return res.status(200).json({ message: 'Password reset link sent to user email.' });
    } else {
      logger.info(`[admin/reset-password] Link issued. [Email: ${user.email}] [ID: ${user._id}]`);
      return res.status(200).json({ link });
    }
  } catch (err) {
    logger.error('[admin/reset-password]', err);
    return res.status(500).json({ message: 'Failed to generate password reset link.' });
  }
});

module.exports = router;

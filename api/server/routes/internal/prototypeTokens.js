const express = require('express');

const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,256}$/;
const STAGES = new Set(['generation', 'transfer', 'dependency_preparation', 'build_qa', 'publish']);
const ID_FIELDS = ['jobId', 'turnId', 'commandId', 'attemptId', 'executionId', 'leaseId'];

function validBody(body) {
  return (
    body &&
    Object.keys(body).length === 8 &&
    ID_FIELDS.every(
      (key) => typeof body[key] === 'string' && SAFE_ID.test(body[key]),
    ) &&
    STAGES.has(body.stage) &&
    Number.isSafeInteger(body.fenceToken) &&
    body.fenceToken > 0
  );
}

function createPrototypeTokenRouter({ authenticateWorker, loadExecution, tokenService }) {
  const router = express.Router();
  router.post('/refresh', async (req, res) => {
    if (!(await authenticateWorker(req))) {
      return res.status(401).json({ error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED' } });
    }
    if (!validBody(req.body)) {
      return res.status(422).json({ error: { code: 'PROTOTYPE_INVALID_REQUEST' } });
    }
    try {
      const lookup = {
        jobId: req.body.jobId,
        turnId: req.body.turnId,
        commandId: req.body.commandId,
        attemptId: req.body.attemptId,
        executionId: req.body.executionId,
        stage: req.body.stage,
        fenceToken: req.body.fenceToken,
        leaseId: req.body.leaseId,
      };
      const execution = await loadExecution(lookup);
      if (!execution) {
        return res.status(409).json({ error: { code: 'PROTOTYPE_STALE_REVISION' } });
      }
      const token = await tokenService.issue(execution);
      return res.status(200).json({
        token,
        expiresAt: new Date(typeof tokenService.expiresAt === 'function'
          ? tokenService.expiresAt(execution, token) : execution.leaseExpiresAt).toISOString(),
      });
    } catch {
      return res.status(409).json({ error: { code: 'PROTOTYPE_STALE_REVISION' } });
    }
  });
  return router;
}

module.exports = { createPrototypeTokenRouter };

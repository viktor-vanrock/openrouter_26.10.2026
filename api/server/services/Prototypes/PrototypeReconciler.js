class PrototypeReconciler {
  constructor(deps) { this.deps = deps; }

  async runOnce() {
    const jobs = await this.deps.findRecoverable();
    for (const job of jobs) {
      if ((job.status === 'queued' && job.commandMissing) || (job.status === 'running' && job.leaseExpired)) {
        await this.deps.requeue(job);
      }
    }
    return jobs.length;
  }
}

module.exports = { PrototypeReconciler };

if (process.argv[2] === 'execute-stage') {
  await import('./stage-entrypoint.js');
} else {
  const { runRole } = await import('./run-role.js');
  try {
    await runRole(process.env.PROTOTYPE_SERVICE_ROLE);
  } catch (error) {
    // Config errors are constructed from field names only. Never print arbitrary dependency errors.
    const code =
      error.code === 'PROTOTYPE_CONFIG_INVALID' ? error.code : 'PROTOTYPE_STARTUP_FAILED';
    const detail = code === 'PROTOTYPE_CONFIG_INVALID' ? `: ${error.message}` : '';
    if (process.env.NODE_ENV === 'production') {
      const { serviceLogger } = await import('./local-log.js');
      const { errorLogFields } = await import('./service-log.js');
      serviceLogger(null)('service.startup_failed', {
        ...errorLogFields(error),
        reason: errorLogFields(error).code,
        code,
        ...(code === 'PROTOTYPE_CONFIG_INVALID' ? { diagnostics: [error.message] } : {}),
      });
    } else {
      process.stderr.write(`${code}${detail}\n`);
      if (code === 'PROTOTYPE_CONFIG_INVALID')
        process.stderr.write(
          'Production requires explicit process env. For local development use npm run prototype:dev.\n',
        );
    }
    process.exitCode = 1;
  }
}

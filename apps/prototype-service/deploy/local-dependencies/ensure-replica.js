// Executed only by mongosh in the local dependency container. Never reconfigures existing data.
const expectedSet = 'prototype-rs';
try {
  let status;
  try {
    status = rs.status();
  } catch (error) {
    if (error.code !== 94 && error.codeName !== 'NotYetInitialized') throw error;
    const result = rs.initiate({
      _id: expectedSet,
      members: [{ _id: 0, host: 'prototype-mongo:27017' }],
    });
    if (result.ok !== 1) quit(1);
    // Primary election is asynchronous. The next healthcheck verifies it.
    quit(1);
  }
  const hello = db.adminCommand({ hello: 1 });
  if (
    status.set !== expectedSet ||
    hello.setName !== expectedSet ||
    hello.isWritablePrimary !== true
  )
    quit(1);
  print('prototype replica set writable primary');
  quit(0);
} catch (error) {
  // Diagnostics contain no connection string or database content.
  print(`prototype replica set not ready: ${error.codeName || error.code || 'CHECK_FAILED'}`);
  quit(1);
}

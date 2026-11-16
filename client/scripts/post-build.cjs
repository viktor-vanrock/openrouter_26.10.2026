const fs = require('node:fs/promises');

async function postBuild() {
  try {
    await fs.cp('public/assets', 'dist/assets', { recursive: true });
    await fs.copyFile('public/robots.txt', 'dist/robots.txt');
    console.log('✅ PWA icons and robots.txt copied successfully. Glob pattern warnings resolved.');
  } catch (err) {
    console.error('❌ Error copying files:', err);
    process.exit(1);
  }
}

postBuild();

// Read PE resources without launching either executable. Checks the portable launcher
// and the inner Electron app, whose resources require separate electron-builder options.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Data, NtExecutable, NtExecutableResource, Resource } = require('../desktop/node_modules/resedit');

const root = path.resolve(__dirname, '..');
const { version } = require('../desktop/package.json');
const source = Data.IconFile.from(fs.readFileSync(path.join(root, 'desktop/assets/codewatch.ico')));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const sha = data => crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');
const expected = source.icons.map((icon, index) => {
  assert.equal(icon.width || 256, sizes[index], 'ICO width');
  assert.equal(icon.height || 256, sizes[index], 'ICO height');
  assert.equal(icon.bitCount, 32, 'ICO color depth');
  return { size: sizes[index], sha256: sha(icon.data.bin) };
});
assert.equal(expected.length, sizes.length, 'ICO frame count');

function verify(file) {
  const executable = NtExecutable.from(fs.readFileSync(file));
  const { entries } = NtExecutableResource.from(executable);
  const groups = Resource.IconGroupEntry.fromEntries(entries);
  const matching = groups.find(group => {
    const frames = group.getIconItemsFromEntries(entries);
    return frames.length === expected.length && expected.every(frame =>
      frames.some(icon => sha(icon.isIcon() ? icon.generate() : icon.bin) === frame.sha256));
  });
  assert.ok(matching, `${file}: missing the complete CodeWatch icon resource group`);
  return { file: path.relative(root, file), iconGroupId: matching.id, sizes, matchesCanonicalIcon: true };
}

const targets = process.argv.slice(2);
if (!targets.length) {
  targets.push(path.join(root, 'dist/windows', `CodeWatch-${version}-x64-portable.exe`));
  targets.push(path.join(root, 'dist/windows/win-unpacked/CodeWatch.exe'));
}
console.log(JSON.stringify({ passed: true, executables: targets.map(file => verify(path.resolve(file))) }, null, 2));

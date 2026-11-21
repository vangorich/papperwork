// electron-builder afterPack hook — strips files that ship inside the Electron
// dist archives but are useless at runtime.
//
// win_clang_x64/: the arm64 Electron zip carries the x64 mksnapshot toolchain
// blobs (icudtl.dat + snapshot_blob.bin, ~11 MB) used only while generating
// V8 snapshots at build time. electron-builder copies them into the package
// root, so every install would carry them dead. Harmless on x64 builds (the
// folder only exists in the arm64 dist), so the hook is shared.
const { rmSync } = require('fs')
const { join } = require('path')

exports.default = async function afterPack(context) {
  rmSync(join(context.appOutDir, 'win_clang_x64'), { recursive: true, force: true })
}

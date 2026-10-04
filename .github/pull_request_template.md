## What does this change?

<!-- A short summary, and the reason for it. Link any issue it closes: "Closes #12". -->

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] Assets / visual change
- [ ] Docs or tooling
- [ ] Refactor (no behaviour change)

## Affected area

- [ ] Engine (`engine/`)
- [ ] Windows host (`hosts/windows/`)
- [ ] macOS host (`hosts/macos/`)
- [ ] Linux host (`hosts/linux/`)
- [ ] Tauri app (`src-tauri/`)
- [ ] CI / scripts / docs

## Checklist

- [ ] `npm test` passes locally
- [ ] Python and shell hosts still compile (`python3 -m py_compile hosts/linux/nightdrive.py hosts/macos/build_macos.py`, `bash -n hosts/linux/install-linux.sh`)
- [ ] New binary assets are added to `engine/assets/manifest.json` when they are scene assets
- [ ] If the engine markup changed, `index.html` references resolve (covered by `npm test`)
- [ ] Screenshots added for visible changes
- [ ] `CHANGELOG.md` updated for user-facing changes

## Screenshots / notes

<!-- Before & after shots for visual changes; anything a reviewer should know. -->

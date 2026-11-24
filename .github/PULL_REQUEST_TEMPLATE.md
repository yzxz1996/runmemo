## Summary

<!-- Briefly explain what this PR changes and why. -->

## Changes

- 

## Verification

- [ ] `node --check` passes on all modified `.mjs` files
- [ ] `npm test` passes completely using isolated `os.tmpdir()` directories (zero real CLI spawns, zero home config mutations)
- [ ] `npm run demo` completes cleanly offline
- [ ] Preserves zero-dependency / non-blocking hook architecture

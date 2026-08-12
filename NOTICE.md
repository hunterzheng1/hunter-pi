# Notices and provenance

## Hunter Pi original work

Hunter Pi original source code and documentation are licensed under the repository [MIT License](LICENSE).

Copyright (c) 2026 hunterzheng1.

The MIT License applies only to material for which the Hunter Pi copyright holder has authority to grant it. It does not relicense dependencies, upstream artifacts, copied code, generated assets with separate terms, or user-installed Pi Packages.

## Current upstream references

The initial documentation baseline studies these projects without incorporating their source code:

| Project | Frozen reference | License observed at that reference | Current use |
|---|---|---|---|
| Pi | [`v0.84.1`](https://github.com/earendil-works/pi/tree/v0.84.1), npm `sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==` | [MIT](https://github.com/earendil-works/pi/blob/v0.84.1/LICENSE) | exact Engine dependency used by Hunter Pi `0.1.0-dev.1`; provider-independent interfaces are probed, while new real-Provider acceptance remains `NOT_PROVEN` |
| Oh My Pi | [`v17.2.4`](https://github.com/can1357/oh-my-pi/tree/v17.2.4) | [MIT](https://github.com/can1357/oh-my-pi/blob/v17.2.4/LICENSE) | research/implementation reference only |
| Hunter-Harness | [`b73db2a`](https://github.com/hunterzheng1/Hunter-Harness/commit/b73db2a23d0ed671c228640a37386b5c0dbef1e7) | no license conclusion recorded here | mechanism and engineering reference only; no runtime or copied-code dependency |
| pi-silent-gui | [`8edf709`](https://github.com/IIwate/pi-silent-gui/commit/8edf70993d41c2fd62e8278fce7ad82f151955b1) | [MIT](https://github.com/IIwate/pi-silent-gui/blob/8edf70993d41c2fd62e8278fce7ad82f151955b1/LICENSE) | Task 7 Windows Job Object sequencing cross-check only; no runtime dependency or copied Python source |

This table records provenance, not compatibility, security, or production verification.

## Current build and shipped dependencies

| Package | Exact version/integrity | License | Distribution role |
|---|---|---|---|
| Zod | `4.4.3`, `sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==` | MIT, Copyright (c) 2025 Colin McDonnell | bundled into `dist/hpi.js`; the exact license is shipped at `apps/cli/third-party/zod-LICENSE` |
| esbuild | `0.28.1`, `sha512-HrJrvZv5ayxBzPfwphOoNzkzOIIlifzk0KJrGK2c8R4+LKpMtpYLQeUdjnwjWv/LZlkH2laZk+4w78pi99D4Vw==` | MIT, Copyright (c) 2020 Evan Wallace | build-time bundler only; not shipped as executable product code |

The generated developer-preview tarball includes the Hunter Pi `LICENSE` and `THIRD_PARTY_NOTICES.md`; installed Pi and its transitive dependencies retain their own npm package licenses and notices.

## Required provenance record

Before externally derived source or assets enter the repository, add an entry under [`docs/provenance/`](docs/provenance/) that records:

- upstream project and canonical source URL;
- exact commit, tag, package version, integrity, and original path;
- upstream license and required copyright/notice text;
- Hunter Pi destination files and material modifications;
- compatibility with the repository license and planned distribution;
- reviewer, review date, and the exact release inventory that consumes it.

Unknown, incompatible, mutable-only, or unverifiable terms block incorporation and publication. Ideas may be independently reimplemented, but copied expression must never be disguised as an idea-only port.

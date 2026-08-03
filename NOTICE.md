# Notices and provenance

## Hunter Pi original work

Hunter Pi original source code and documentation are licensed under the repository [MIT License](LICENSE).

Copyright (c) 2026 hunterzheng1.

The MIT License applies only to material for which the Hunter Pi copyright holder has authority to grant it. It does not relicense dependencies, upstream artifacts, copied code, generated assets with separate terms, or user-installed Pi Packages.

## Current upstream references

The initial documentation baseline studies these projects without incorporating their source code:

| Project | Frozen reference | License observed at that reference | Current use |
|---|---|---|---|
| Pi | [`v0.83.0`](https://github.com/earendil-works/pi/tree/v0.83.0), npm integrity frozen in `package-lock.json` | [MIT](https://github.com/earendil-works/pi/blob/v0.83.0/LICENSE) | exact external dependency used by the isolated Task 4 public-interface spike; real Provider/product qualification remains `NOT_PROVEN` |
| Oh My Pi | [`v17.2.4`](https://github.com/can1357/oh-my-pi/tree/v17.2.4) | [MIT](https://github.com/can1357/oh-my-pi/blob/v17.2.4/LICENSE) | research/implementation reference only |
| Hunter-Harness | [`b73db2a`](https://github.com/hunterzheng1/Hunter-Harness/commit/b73db2a23d0ed671c228640a37386b5c0dbef1e7) | no license conclusion recorded here | mechanism and engineering reference only; no runtime or copied-code dependency |

This table records provenance, not compatibility, security, or production verification.

## Required provenance record

Before externally derived source or assets enter the repository, add an entry under [`docs/provenance/`](docs/provenance/) that records:

- upstream project and canonical source URL;
- exact commit, tag, package version, integrity, and original path;
- upstream license and required copyright/notice text;
- Hunter Pi destination files and material modifications;
- compatibility with the repository license and planned distribution;
- reviewer, review date, and the exact release inventory that consumes it.

Unknown, incompatible, mutable-only, or unverifiable terms block incorporation and publication. Ideas may be independently reimplemented, but copied expression must never be disguised as an idea-only port.

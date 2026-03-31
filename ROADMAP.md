<!--
SPDX-FileCopyrightText: 2026 Euro-Office contributors
SPDX-License-Identifier: CC0-1.0
-->

# Euro-Office Integration Roadmap

> This roadmap covers the integration of Euro-Office DocumentServer with external platforms (OpenCloud, SOGo, Open-Xchange, Zimbra) via WOPI and Docs API protocols.
>
> Full integration planning document: [.github/INTEGRATION-PLANNING.md](https://github.com/Euro-Office/DocumentServer/blob/main/.github/INTEGRATION-PLANNING.md)

## Role in Integration

This repo implements the **WOPI server** and **Docs API backend** that external platforms connect to. It is the primary integration target for all platform connectors.

## Roadmap Items

### Phase 1 — Foundation

- [ ] Verify WOPI endpoint correctness and completeness against the [WOPI specification](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/)
  - `/hosting/discovery` — WOPI discovery XML endpoint
  - `CheckFileInfo` — File metadata retrieval
  - `GetFile` — File content retrieval
  - `PutFile` — File save-back
  - `Lock` / `Unlock` / `RefreshLock` — Concurrent editing locks
  - `PutRelativeFile` — New file / save-as
- [ ] Ensure WOPI proof key generation and rotation work reliably
  - RSA key pair management
  - Proof key verification on incoming WOPI requests
- [ ] Validate WOPI discovery XML output matches what standard WOPI clients expect
  - Supported file extensions and actions
  - URL templates for view/edit
  - Proof key exposure in discovery
- [ ] Test Docs API compatibility with the patterns used by Zimbra's integration
  - JWT authentication flow
  - Callback URL handling
  - Editor configuration JSON schema
- [ ] Document the WOPI client implementation requirements for third-party platforms
- [ ] Publish integration SDK examples (WOPI client reference, Docs API configuration)

### Shared Requirements (this repo)

- [ ] **IP whitelisting** — Restrict which host platform IPs can access DocumentServer
- [ ] **Health check endpoint** — For host platforms to verify DocumentServer availability
- [ ] **Logging and monitoring** — Structured logs for integration troubleshooting
- [ ] **JWT authentication** — Token-based access control for Docs API integrations
- [ ] **WOPI settings admin panel** — Configuration UI in `AdminPanel/` (React 18 SPA)

---

## Cross-Repo References

| Repo | Role |
|------|------|
| [server](https://github.com/Euro-Office/server) | WOPI endpoints, discovery, proof keys, JWT, admin panel |
| [sdkjs](https://github.com/Euro-Office/sdkjs) | Docs API, editor engine, co-editing, format conversion |
| [web-apps](https://github.com/Euro-Office/web-apps) | Editor UI, toolbar, plugins, branding |
| [core](https://github.com/Euro-Office/core) | File format conversion engine (OOXML, ODF, PDF) |
| [eurooffice-nextcloud](https://github.com/Euro-Office/eurooffice-nextcloud) | OpenCloud/Nextcloud WOPI connector |
| [DocumentServer](https://github.com/Euro-Office/DocumentServer) | Integration orchestration, Docker, Helm |
| [document-server-integration](https://github.com/Euro-Office/document-server-integration) | Integration examples & API docs |
| [document-server-package](https://github.com/Euro-Office/document-server-package) | DEB/RPM/Helm packaging |
| [docker-ci](https://github.com/Euro-Office/docker-ci) | Docker images for deployment |
| [desktop-sdk](https://github.com/Euro-Office/desktop-sdk) | Desktop CEF integration |
| [desktop-apps](https://github.com/Euro-Office/desktop-apps) | Desktop packaging & Electron wrappers |

## Protocol Documentation

- [WOPI Protocol Overview — Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/)
- [WOPI Overview — ONLYOFFICE API](https://api.onlyoffice.com/docs/docs-api/using-wopi/overview/)
- [WOPI REST API — ONLYOFFICE API](https://api.onlyoffice.com/docs/docs-api/using-wopi/wopi-rest-api/)
- [WOPI Discovery — ONLYOFFICE API](https://api.onlyoffice.com/docs/docs-api/using-wopi/wopi-discovery/)
- [Docs API Basic Concepts — ONLYOFFICE API](https://api.onlyoffice.com/docs/docs-api/get-started/basic-concepts/)

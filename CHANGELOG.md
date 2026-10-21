# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-13
### Added
- Renamed to `@sigrun/ext-tool-search` for the 0.1.0 release (repo
  stays `sigrun-ai/sigrun-ext-tool-search`): published package metadata
  (`publishConfig` access/provenance), host modules moved to
  `peerDependencies` mirrored in `devDependencies` at exact `1.3.0`, the
  test-only `@sigrun/ext-mcp` devDependency re-keyed to its published
  name (`file:` dev shape until Task 8), CHANGELOG.md joined the files
  whitelist, and a manifest hygiene check wired into `npm test`.
- sigrun loader-contract wrapper over pi-durable's `createToolSearchExtension`
  (BM25 tool_search over `agent.deferred`), plus the installed-not-offered
  notice section and the end-to-end deferred-tools suite.

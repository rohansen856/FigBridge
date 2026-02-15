# Claude Code hook payload fixtures

Sanitised from real payloads captured with Claude Code 2.1.296 on Linux.
Session IDs, transcript paths and script bodies are replaced with placeholders; every
field name and the field structure are exactly as captured.

| File | Source |
|---|---|
| `failure.claude-ai.get_metadata.json` | real capture (claude.ai Figma connector, no edit access) |
| `failure.claude-ai.use_figma.json` | real capture (same) |
| `success.plugin.use_figma.json` | **synthetic** — success payload not yet captured; shape follows the hooks docs. Replace in the Phase 5 manual test. |

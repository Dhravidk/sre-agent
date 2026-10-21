# Claude Code entry point

Read and follow [AGENTS.md](AGENTS.md) before working on this repository. It is the shared source of instructions for coding agents.

For an Ally implementation, read these in order:

1. [Human system walkthrough and Mermaid diagrams](docs/HUMAN-GUIDE.md)
2. [Ally developer handoff](docs/ALLY-HANDOFF.md)
3. [Connector and service checklist](docs/ALLY-INTEGRATION-CHECKLIST.md)
4. [Architecture and code map](docs/ARCHITECTURE.md)
5. [Implementation brief and suggested prompt](docs/ALLY-AGENT-PROMPT.md)

The project contains a working synthetic lab and a persistent integration runtime. It does not include Ally credentials, an Ally deployment, verified Ally MCP schemas, or a production execution workflow. The connected runtime invokes an approved `claude -p` installation; your role as the coding agent is to adapt and validate the host service and its integrations. These are separate roles.

Keep read-only access, model inference, Teams delivery, local QA, and deployment execution as distinct acceptance steps. Preserve the application's scope, authorization, durability, and recovery checks. Record unknown enterprise contracts instead of guessing them.

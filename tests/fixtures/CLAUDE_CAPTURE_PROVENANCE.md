# Claude Code payload provenance

These fixtures came from a real Claude Code 2.1.275 interactive session using a temporary capture-only plugin. The operator accepted the ordinary workspace trust dialog. Permission bypass was disabled, the updater was disabled, and no personal settings were changed.

The 29 included records cover session start and end, Read, Write, Edit, Bash success and failure, ToolSearch, local MCP tools, Agent, child-agent Read, subagent start and stop, WebFetch, and WebSearch admission. The local file and MCP content was synthetic. WebFetch used example.com. The unrelated public WebSearch response and an interrupted onboarding session were excluded.

Scratch paths were normalized to /tmp/agentguard-fixture. Session, prompt, agent, and tool-use identifiers were replaced consistently with synthetic identifiers of the same shape. References inside nested response fields received the same replacements. Field names, measured durations, input structure, output structure, and synthetic content were preserved. No missing event or response was invented.

Raw payloads and their hashes are retained outside this package. The capture plugin is a verification aid and is not part of the shipped runtime.

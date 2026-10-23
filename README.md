# claude-mods

Claude Code mods by Nereo Valeriano. Each one is a plugin in this marketplace.

| Mod | What it does |
| --- | --- |
| **auto-model** | Picks the model and effort for each of your prompts, and the model for each subagent. Shows a colored bar under the input (above it in Desktop) with the model, effort, context and limits. |
| **where-am-i** | A card above the prompt with where the session stands: goal, status and recent progress, plus suggested next steps with clickable number badges. Fork of Hamza Zafar's where-am-i, with his next-steps folded in. |

## Install

```
/plugin marketplace add Luminous13/claude-mods
/plugin install auto-model@claude-mods
/plugin install where-am-i@claude-mods
```

Don't also install Hamza's originals of where-am-i or next-steps. where-am-i has the same name and would clash, and next-steps would draw a second list of suggestions.

If you installed next-steps from here before, uninstall it: where-am-i does its job now.

## where-am-i settings

- **Suggested next steps** (on by default): after each turn, 2 or 3 likely next prompts inside the card, one small Haiku call per turn. Turn it off to keep the plain Next row.
- **Leader key** (`;`, `,` or `\`): type it in an empty prompt, then 1, 2 or 3 to draft a suggestion, or 0 to dismiss them. A bare digit types as usual.

## auto-model picker

Set `picker` in the plugin settings:

- **jev** (default): needs a TypeSafe API key at api.typesafe.ai. Set it in the settings or as `TYPESAFE_API_KEY`.
- **openai**: needs an OpenAI API key, set in the settings or as `OPENAI_API_KEY`.
- **claude**: asks Haiku through your own Claude Code session. Needs no key, and nothing goes to a third party. Its confidence is its own estimate and a pick takes longer.

Subagent picking was ported from Hamza Zafar's switchboard. See [NOTICE.md](mods/auto-model/NOTICE.md).

## Licence

MIT. See [LICENSE](LICENSE). The where-am-i fork keeps Hamza Zafar's copyright; see its NOTICE.md.

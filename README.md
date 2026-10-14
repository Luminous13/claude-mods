# claude-mods

Claude Code mods by Nereo Valeriano. Each one is a plugin in this marketplace.

| Mod | What it does |
| --- | --- |
| **auto-model** | Picks the model and effort for each of your prompts, and the model for each subagent. Shows a colored bar under the input with the model, effort, context and limits. |
| **where-am-i** | A card above the prompt with where the session stands: goal, status and recent progress. Fork of Hamza Zafar's where-am-i. |
| **next-steps** | Suggested next steps, shown in the where-am-i card with clickable number badges. Fork of Hamza Zafar's next-steps. |

## Install

```
/plugin marketplace add Luminous13/claude-mods
/plugin install auto-model@claude-mods
/plugin install where-am-i@claude-mods
/plugin install next-steps@claude-mods
```

Install where-am-i and next-steps together: the where-am-i card shows what next-steps suggests.

Don't also install Hamza's originals of where-am-i or next-steps. They have the same names and would clash.

## auto-model picker

Set `picker` in the plugin settings:

- **jev** (default): needs a TypeSafe API key at api.typesafe.ai. Set it in the settings or as `TYPESAFE_API_KEY`.
- **openai**: needs an OpenAI API key, set in the settings or as `OPENAI_API_KEY`.
- **claude**: asks Haiku through your own Claude Code session. Needs no key, and nothing goes to a third party. Its confidence is its own estimate and a pick takes longer.

Subagent picking was ported from Hamza Zafar's switchboard. See [NOTICE.md](mods/auto-model/NOTICE.md).

## Licence

MIT. See [LICENSE](LICENSE). The where-am-i and next-steps forks keep Hamza Zafar's copyright; see their NOTICE.md files.

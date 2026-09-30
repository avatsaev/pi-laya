# pi-laya

A [pi](https://pi.dev) extension that lets the agent ask a [Laya](https://github.com/NandhaKishorM/laya) server typed questions about a piece of text.

Source: <https://github.com/avatsaev/pi-laya>

- **`laya_decide` tool**: sends one text and any number of `choice`, `score` or `yes_no` questions to `POST /v1/systemone`, and returns every answer with its probability, the model Laya used, and a flag for low-confidence answers.
- **`/laya` command**: shows the configured server and its `/health`. `/laya setup` asks for the URL and API key and saves them.

## Install

```bash
pi install git:github.com/avatsaev/pi-laya
```

To try it for one session only, or to work on it locally:

```bash
git clone https://github.com/avatsaev/pi-laya.git
pi -e ./pi-laya                 # load for this session only
pi install ./pi-laya            # or install the local checkout
```

## Configure

Set the server URL and API key in one of these ways. The first one found wins:

1. Environment variables `LAYA_API_URL` and `LAYA_API_KEY`.
2. `<agent-dir>/laya.json` (usually `~/.pi/agent/laya.json`). `/laya setup` writes this file with mode `600`:

   ```json
   { "url": "https://laya.example.com", "apiKey": "your-key" }
   ```

The key is optional if the server runs without `LAYA_API_KEY`. Run `/laya` to check the configuration.

## Tool parameters

| parameter | description |
|---|---|
| `state` | the text to decide about |
| `questions` | list of `{id, type, question, options}`. `type` is `choice`, `score` or `yes_no`. `options` holds `{label, description}` entries for `choice`, or the levels from lowest to highest for `score`; omit it for `yes_no`. |
| `model` | optional: `english`, `multilingual` or `typed-decisions`; otherwise Laya picks one from the text |
| `lang` | optional language code of the text, e.g. `fr` |
| `min_confidence` | optional: flag answers below this confidence |

The tool retries up to 3 times when the server answers `503` (busy), waiting as long as its `Retry-After` header says. Each request times out after 60 s.

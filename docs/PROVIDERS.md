# Connect a text provider

Open **Settings → API connections → OpenAI-compatible text provider**. Enter the base URL including the provider's API prefix, choose the API format, enter its API key, and save. Then set **Script model** in the studio to the exact model ID your account supports.

| Service shape | Base URL example | Format |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | Responses |
| Compatible hosted gateway | `https://your-provider.example/v1` | Responses or Chat Completions, as documented by that provider |
| Local model server | `http://127.0.0.1:1234/v1` | Usually Chat Completions; verify server support |

Convo appends `/responses` or `/chat/completions`. Do not include that suffix yourself. HTTPS is required for remote endpoints; HTTP is allowed on loopback addresses. URLs containing credentials, query parameters, or fragments are rejected.

An empty key preserves the saved key only when the normalized base URL is unchanged. Changing the address requires a new key, except for local HTTP services, where a key is optional. Saved endpoint settings take precedence over the legacy `OPENAI_API_KEY` development fallback. ElevenLabs retains its separate key and endpoint.

## Compatibility requirements

The model must support **structured JSON Schema output**, sufficient context, and the requested output budget. A service calling itself OpenAI-compatible does not necessarily implement every required field.

- **Responses:** accepts `instructions`, string `input`, `max_output_tokens`, `store: false`, and `text.format` with a strict JSON Schema. Returns completed Responses-style output text.
- **Chat Completions:** accepts system/user `messages`, `max_completion_tokens`, and `response_format: { type: "json_schema", json_schema: … }`. Returns string `choices[0].message.content` with `finish_reason: "stop"`.
- Refusals, missing text, truncated responses, and invalid structured content are rejected. Convo does not automatically retry a billable request using another protocol.
- Both the character-planning stage and dialogue-writing stage use this connection. Existing valid character plans can be reused.

Protocol references: [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create) and [Chat Completions](https://developers.openai.com/api/reference/resources/chat).

## Troubleshooting

**401/403:** Verify this endpoint's key, account access, and selected model. Saving a connection stores it locally; it does not perform a paid generation or certify provider access.

**404:** Check the base path and format. Some gateways expose only one of the two APIs.

**400 or unsupported parameter:** Check JSON Schema and `max_completion_tokens` support. Older Chat-compatible services may accept only `max_tokens`; that variant is not currently implemented. Choose a compatible service/model rather than repeatedly retrying.

**Incomplete generation:** Reduce the target duration or use a model with a larger output budget. A long conversation also needs enough context for cast plans and delivery instructions.

**Local connection failure:** Start your local server and verify its port. Browser preview cannot call provider APIs; use the desktop app.

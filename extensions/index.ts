/**
 * pi-provider-gd — self-contained native `gd` provider for api.girard-davila.net.
 *
 * Installing this package is the whole setup:
 *   pi install git:github.com/alx/pi-provider-gd
 *
 * It registers a native pi provider `gd` that streams OpenAI-compatible
 * requests to the endpoint and discovers models from /v1/models.
 *
 * After install:
 *   /login gd      — either paste an API key created at
 *                    https://api.girard-davila.net/api/llm/ui/ or sign in via
 *                    browser SSO (GitHub → issued key); the key is stored in
 *                    ~/.pi/agent/auth.json under "gd". No hand-editing, no
 *                    separate pi-provider-litellm install.
 *   /model         — pick gd/<model-id>; it appears here, no pi restart.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGdProvider } from "../src/provider.ts";

export default function gdExtension(pi: ExtensionAPI) {
	pi.registerProvider(createGdProvider());
}

/**
 * Release gate for Adepthood's self-hosted model path.
 *
 * Keep this false until the backend has a real Adepthood-operated provider.
 * Withholding a person's BYOK key currently falls back to BotMason's shared
 * OpenAI/Anthropic provider, so it must never be presented as self-hosted.
 */
export const LOCAL_MODEL_AVAILABLE = false;

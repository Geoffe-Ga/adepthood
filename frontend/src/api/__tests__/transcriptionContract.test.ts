/* eslint-env jest */
/* global describe, test, expect */
import {
  DIRECT_VISION_MODELS,
  TRANSCRIPTION_MAX_TOKENS,
  TRANSCRIPTION_SYSTEM_PROMPT,
  classifyTranscription,
} from '../transcriptionContract';

import { readBackendSource } from '@/testing/backendSource';

/**
 * The device's page read is a mirror of the server's (ADR 0009 phase (a),
 * #3067), held to one shared fixture. `backend/tests/test_transcription_client_contract.py`
 * derives every field of that fixture from the Python -- the prompt, the model
 * and token budget captured off the server's own wire request, and each pinned
 * reply's verdict -- and this file holds the TypeScript to the same file. The
 * read goes through `@/testing/backendSource`, which is what makes backend CI
 * run this file on the change that would break it.
 */
interface Contract {
  system_prompt: string;
  max_tokens: number;
  registry_default_models: Record<string, string>;
  classify_cases: { reply: string; verdict: string }[];
}

const contract = JSON.parse(
  readBackendSource('tests', 'fixtures', 'transcription_contract', 'transcription_contract.json'),
) as Contract;

describe('the client-direct page read mirrors the server contract', () => {
  test('sends the same system prompt', () => {
    expect(TRANSCRIPTION_SYSTEM_PROMPT).toBe(contract.system_prompt);
  });

  test('asks for the same token budget', () => {
    expect(TRANSCRIPTION_MAX_TOKENS).toBe(contract.max_tokens);
  });

  test('always uses each vendor registry default model, and names no other vendor', () => {
    // The operator's LLM_MODEL configures the server's own dial; a device-direct
    // read never reaches the server, so it is not governed by it.
    expect({ ...DIRECT_VISION_MODELS }).toEqual(contract.registry_default_models);
  });

  test.each(contract.classify_cases.map((c) => [c.verdict, c.reply] as const))(
    'classifies a %s reply as the server does',
    (verdict, reply) => {
      expect(classifyTranscription(reply)).toBe(verdict);
    },
  );

  test('the fixture reaches every verdict, so the cases above cannot pass by omission', () => {
    expect(new Set(contract.classify_cases.map((c) => c.verdict))).toEqual(
      new Set(['transcribed', 'no_text_found', 'transcription_refused']),
    );
  });
});

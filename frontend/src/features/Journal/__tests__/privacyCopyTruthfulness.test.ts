import { describe, expect, it } from '@jest/globals';

import { DELETE_ENTRY_BODY } from '../deleteEntryCopy';

import { LOCAL_MODEL_UNAVAILABLE_NOTE } from '@/features/Settings/localModelCopy';

describe('privacy choice copy follows shipped behavior (#3275)', () => {
  it('describes recorded deletion retries without promising an already removed remote copy', () => {
    expect(DELETE_ENTRY_BODY).toMatch(/requested.*removal/i);
    expect(DELETE_ENTRY_BODY).toMatch(/until.*confirms/i);
    expect(DELETE_ENTRY_BODY).toMatch(/automatically.*retries|retries.*automatically/i);
    expect(DELETE_ENTRY_BODY).not.toMatch(/so you can try again|is removed too/i);
  });

  it('does not offer the removed shared keyless provider as the unavailable-model fallback', () => {
    expect(LOCAL_MODEL_UNAVAILABLE_NOTE).not.toMatch(/shared provider|when no key is saved/i);
    expect(LOCAL_MODEL_UNAVAILABLE_NOTE).toMatch(/own.*API key|API key.*own/i);
  });
});

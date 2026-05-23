/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { practiceRecipes, practiceTags } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

const recipeFixture = {
  id: 7,
  slug: 'find_the_rainbow',
  name: 'Find the Rainbow',
  description: '',
  owner_user_id: null,
  mode: 'tallied_grounding',
  rounds: 3,
  created_at: '2026-05-23T00:00:00Z',
  steps: [
    {
      position: 0,
      tag_slug: 'red',
      tag_label: 'Red',
      prompt_label: 'Find red',
      target_count: 1,
    },
  ],
};

describe('practiceRecipes.list', () => {
  test('GETs /practice-recipes/ without mode by default', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([recipeFixture]));
    const out = await practiceRecipes.list();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-recipes/');
    expect(init.method).toBeUndefined();
    expect(out).toEqual([recipeFixture]);
  });

  test('appends ?mode= when provided', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([recipeFixture]));
    await practiceRecipes.list('tallied_grounding');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-recipes/?mode=tallied_grounding');
  });

  test('rejects payload with missing fields', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([{ slug: 'incomplete' }]));
    await expect(practiceRecipes.list()).rejects.toThrow('Invalid practice-recipes response');
  });
});

describe('practiceRecipes.create', () => {
  test('POSTs the payload and parses the response', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(recipeFixture, 201));
    const out = await practiceRecipes.create({
      slug: 'my_recipe',
      name: 'My Recipe',
      mode: 'tallied_grounding',
      rounds: 3,
      steps: [
        {
          tag_slug: 'red',
          tag_label: 'Red',
          prompt_label: 'Find red',
          target_count: 1,
        },
      ],
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-recipes/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).slug).toBe('my_recipe');
    expect(out).toEqual(recipeFixture);
  });
});

describe('practiceRecipes.update', () => {
  test('PATCHes the recipe id', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(recipeFixture));
    await practiceRecipes.update(7, {
      name: 'Renamed',
      rounds: 2,
      steps: [{ tag_slug: 'red', tag_label: 'Red', prompt_label: 'x', target_count: 1 }],
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-recipes/7');
    expect(init.method).toBe('PATCH');
  });
});

describe('practiceRecipes.remove', () => {
  test('DELETEs the recipe id', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(null, 204));
    await practiceRecipes.remove(11);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-recipes/11');
    expect(init.method).toBe('DELETE');
  });
});

describe('practiceRecipes.apply', () => {
  test('POSTs apply-to/{user_practice_id}', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        id: 99,
        user_id: 1,
        practice_id: 5,
        stage_number: 1,
        start_date: '2026-05-01',
        end_date: null,
      }),
    );
    await practiceRecipes.apply(7, 99);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-recipes/7/apply-to/99');
    expect(init.method).toBe('POST');
  });
});

describe('practiceTags', () => {
  const tagFixture = {
    id: 3,
    slug: 'red',
    label: 'Red',
    owner_user_id: null,
    created_at: '2026-05-23T00:00:00Z',
  };

  test('list parses the array', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([tagFixture]));
    const out = await practiceTags.list();
    expect(out).toEqual([tagFixture]);
  });

  test('create POSTs and parses', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(tagFixture, 201));
    const out = await practiceTags.create({ slug: 'red', label: 'Red' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-tags/');
    expect(init.method).toBe('POST');
    expect(out).toEqual(tagFixture);
  });

  test('update PATCHes the tag id', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(tagFixture));
    await practiceTags.update(3, { label: 'Crimson' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-tags/3');
    expect(init.method).toBe('PATCH');
  });

  test('remove DELETEs the tag id', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(null, 204));
    await practiceTags.remove(3);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/practice-tags/3');
    expect(init.method).toBe('DELETE');
  });

  test('list rejects invalid payload', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([{ slug: 'no-id' }]));
    await expect(practiceTags.list()).rejects.toThrow('Invalid practice-tags response');
  });
});

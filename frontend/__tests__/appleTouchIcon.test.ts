import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('Safari Add to Home Screen icon', () => {
  it('declares a dedicated Apple touch icon in the web document head', () => {
    const html = readFileSync(resolve(__dirname, '../public/index.html'), 'utf8');
    const head = html.split('</head>')[0];

    expect(head).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
    );
  });

  it('ships a 180px square PNG at the declared public URL', () => {
    const png = readFileSync(resolve(__dirname, '../public/apple-touch-icon.png'));

    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
  });
});

describe('social share preview', () => {
  it('exposes a public preview to crawlers before JavaScript runs', () => {
    const html = readFileSync(resolve(__dirname, '../public/index.html'), 'utf8');
    const head = html.split('</head>')[0];
    const image = readFileSync(resolve(__dirname, '../public/social-preview.png'));

    expect(head).toContain('property="og:type" content="website"');
    expect(head).toContain('property="og:url" content="https://app.aptitude.guru/"');
    expect(head).toContain('name="twitter:card" content="summary_large_image"');
    for (const key of ['property="og:image"', 'name="twitter:image"']) {
      expect(head).toContain(`${key} content="https://app.aptitude.guru/social-preview.png"`);
    }
    expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(image.readUInt32BE(16)).toBe(1200);
    expect(image.readUInt32BE(20)).toBe(630);
  });
});

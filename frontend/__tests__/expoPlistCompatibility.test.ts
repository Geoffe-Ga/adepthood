import plist from '@expo/plist';
import { describe, expect, it } from '@jest/globals';

describe('@expo/plist compatibility with the patched xmldom override', () => {
  it('parses the plist shape used by Expo config plugins', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
        <dict>
          <key>CFBundleDisplayName</key>
          <string>Adepthood</string>
          <key>UIRequiresFullScreen</key>
          <true/>
        </dict>
      </plist>`;

    expect(plist.parse(xml)).toEqual({
      CFBundleDisplayName: 'Adepthood',
      UIRequiresFullScreen: true,
    });
  });
});

# sec-10: Unvalidated URLs before Linking.openURL

**Labels:** `security`, `frontend`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A03:2021 — Injection
**Estimated LoC:** ~20

## Problem

The `ContentViewer` component at
`frontend/src/features/Course/ContentViewer.tsx:104-111` opens URLs from
API responses without validating the URL scheme:

```typescript
const handleOpenUrl = useCallback(async () => {
  if (!item.url) return;
  try {
    await Linking.openURL(item.url);
  } catch (err) {
    console.error('Failed to open URL:', err);
  }
}, [item.url]);
```

`Linking.openURL` supports arbitrary URL schemes. If the backend API is
compromised or returns malformed data, the app could open:

- `javascript:` URIs (XSS on platforms that support WebView-based linking)
- `tel:` or `sms:` URIs (triggers phone actions without user consent)
- `file:` URIs (local file access attempts)
- `intent:` URIs on Android (launch arbitrary activities)

While the URLs currently come from a trusted backend, defense-in-depth
requires client-side validation.

## Tasks

1. **Add a URL validation utility**
   ```typescript
   const ALLOWED_SCHEMES = ['https:', 'http:'];

   function isValidUrl(url: string): boolean {
     try {
       const parsed = new URL(url);
       return ALLOWED_SCHEMES.includes(parsed.protocol);
     } catch {
       return false;
     }
   }
   ```

2. **Validate before opening**
   ```typescript
   const handleOpenUrl = useCallback(async () => {
     if (!item.url || !isValidUrl(item.url)) return;
     try {
       await Linking.openURL(item.url);
     } catch (err) {
       console.error('Failed to open URL:', err);
     }
   }, [item.url]);
   ```

3. **Search for other `Linking.openURL` usages** and apply the same check

4. **Update tests**
   - Test that `http://` and `https://` URLs are opened
   - Test that `javascript:`, `tel:`, `file:` URLs are silently rejected

## Acceptance Criteria

- Only `http:` and `https:` URLs are opened via `Linking.openURL`
- Other URL schemes are silently rejected
- No user-facing error for rejected URLs

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Course/ContentViewer.tsx` | Add URL validation |
| `frontend/src/utils/url.ts` | Create shared URL validator (if other usages exist) |
| `frontend/src/features/Course/__tests__/` | Add URL validation tests |

# Adepthood Frontend

React Native + Expo client (TypeScript, Zustand, React Navigation).

```bash
npm ci          # install from the lockfile
npm start       # Expo dev server
npm test        # Jest
npm run lint    # ESLint
npx tsc --noEmit
```

## Environment variables

Only `EXPO_PUBLIC_*` variables reach the client. They are read at **build**
time and baked into the JavaScript bundle, so changing one requires a
rebuild — and nothing secret should ever go in one, since anyone can read a
shipped bundle.

| Variable                               | Required          | Dev default                                        | Notes                                                                                                    |
| -------------------------------------- | ----------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_API_BASE_URL`             | Yes in production | `http://localhost:8000`                            | Backend API root. Must be HTTPS in production builds, or the app boots to a visible config-error screen. |
| `EXPO_PUBLIC_GUMROAD_PRODUCT_URL`      | No                | `https://adepthood.gumroad.com/l/aptitude`         | Product page opened by the Get Started CTA.                                                              |
| `EXPO_PUBLIC_GUMROAD_HELP_URL`         | No                | `https://help.gumroad.com/article/76-license-keys` | License-key help article linked from the signup form.                                                    |
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS`     | No                | _(unset)_                                          | Google OAuth client ID used on iOS. Unset hides "Continue with Google" on iOS.                           |
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID` | No                | _(unset)_                                          | Google OAuth client ID used on Android. Unset hides "Continue with Google" on Android.                   |
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB`     | No                | _(unset)_                                          | Google OAuth client ID used on web and any other target. Unset hides "Continue with Google" there.       |

Both Gumroad links are public marketing pages with safe defaults, so a missing
override is not a misconfiguration — unlike `EXPO_PUBLIC_API_BASE_URL`, they
never fail the app closed.

The three Google client IDs are the sign-in rollout switch, evaluated per
platform: with no ID for the platform the app is running on (whitespace counts
as no ID), the Google button is not rendered at all and email sign-in is the
only path. Set them one platform at a time to roll the flow out gradually.

For deploy steps and where to set these in Railway, see
[`../DEPLOYMENT.md`](../DEPLOYMENT.md).

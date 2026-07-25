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

| Variable                          | Required          | Dev default                                        | Notes                                                                                                    |
| --------------------------------- | ----------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_API_BASE_URL`        | Yes in production | `http://localhost:8000`                            | Backend API root. Must be HTTPS in production builds, or the app boots to a visible config-error screen. |
| `EXPO_PUBLIC_GUMROAD_PRODUCT_URL` | No                | `https://adepthood.gumroad.com/l/aptitude`         | Product page opened by the Get Started CTA.                                                              |
| `EXPO_PUBLIC_GUMROAD_HELP_URL`    | No                | `https://help.gumroad.com/article/76-license-keys` | License-key help article linked from the signup form.                                                    |

Both Gumroad links are public marketing pages with safe defaults, so a missing
override is not a misconfiguration — unlike `EXPO_PUBLIC_API_BASE_URL`, they
never fail the app closed.

For deploy steps and where to set these in Railway, see
[`../DEPLOYMENT.md`](../DEPLOYMENT.md).

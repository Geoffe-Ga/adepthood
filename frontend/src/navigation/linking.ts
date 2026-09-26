// frontend/src/navigation/linking.ts

import type { LinkingOptions, NavigatorScreenParams } from '@react-navigation/native';

import type { RootTabParamList } from './BottomTabs';
import type { RootStackParamList } from './RootStack';

/**
 * Deep linking configuration. Covers every top-level screen so that
 * ``adepthood://api-key-settings`` (BUG-FRONTEND-INFRA-008) — and future
 * modal routes — can land users exactly where they need to be, not just
 * inside the tab shell.
 */
type LinkedRootParamList = Omit<RootStackParamList, 'Tabs'> & {
  Tabs: NavigatorScreenParams<RootTabParamList>;
};

/**
 * Linking config covering both navigators (auth + root).  The currently
 * mounted navigator (chosen by ``authStatus``) consumes the matching
 * routes; entries for the other navigator are ignored, so listing both
 * stacks here is safe.  ``reset-password?token=...`` is the
 * password-recovery email landing page -- the parser puts ``token``
 * into ``route.params`` so ``ResetPasswordScreen`` can pick it up.
 */
export const linking: LinkingOptions<LinkedRootParamList> = {
  prefixes: ['adepthood://'],
  config: {
    screens: {
      Tabs: {
        screens: {
          Habits: 'habits',
          Practice: 'practice/:stageNumber?',
          Course: 'course/:stageNumber?',
          Journal: 'journal',
          Map: 'map',
        },
      },
      Settings: 'settings',
      ApiKeySettings: 'api-key-settings', // pragma: allowlist secret
      // Practice share-link landing (issue #348). The recipient
      // taps ``adepthood://practices/share/<token>`` -- the parser
      // pulls ``token`` into ``route.params`` for
      // ``SharePreviewScreen`` to fetch + render.
      SharePreview: 'practices/share/:token',
      // Auth-stack routes -- only resolve while the AuthNavigator is mounted.
      // Cast through ``unknown`` because react-navigation's typing for
      // ``screens`` is keyed strictly on the param-list, but the same
      // linking config drives both AuthStack and RootStack here.
      ...({
        GetStarted: 'get-started',
        Login: 'login',
        Signup: 'signup',
        ForgotPassword: 'forgot-password', // pragma: allowlist secret
        ResetPassword: 'reset-password', // pragma: allowlist secret
        // ``cancel-reset?token=...`` is the "this wasn't me" landing
        // for the reset email; matches the URL the email body emits.
        CancelReset: 'cancel-reset', // pragma: allowlist secret
      } as unknown as Record<string, string>),
    },
  },
};

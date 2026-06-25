// One require() per bundled RWS asset_key. Metro statically bundles only
// string-literal require paths, so this map is maintained explicitly (one
// entry per shipped image) rather than built from a loop.
//
// Major Arcana (22) ship today (issue #467); the 56 Minor Arcana land via the
// follow-up that reuses this same pipeline. Keys are the full `asset_key`
// (`rws/<slug>`) so they line up 1:1 with RWS_CARDS in ./rws.
import type { ImageSourcePropType } from 'react-native';

export const RWS_IMAGES: Readonly<Record<string, ImageSourcePropType>> = {
  'rws/the_fool': require('../../../../../assets/cards/rws/the_fool.png') as ImageSourcePropType,
  'rws/the_magician':
    require('../../../../../assets/cards/rws/the_magician.png') as ImageSourcePropType,
  'rws/the_high_priestess':
    require('../../../../../assets/cards/rws/the_high_priestess.png') as ImageSourcePropType,
  'rws/the_empress':
    require('../../../../../assets/cards/rws/the_empress.png') as ImageSourcePropType,
  'rws/the_emperor':
    require('../../../../../assets/cards/rws/the_emperor.png') as ImageSourcePropType,
  'rws/the_hierophant':
    require('../../../../../assets/cards/rws/the_hierophant.png') as ImageSourcePropType,
  'rws/the_lovers':
    require('../../../../../assets/cards/rws/the_lovers.png') as ImageSourcePropType,
  'rws/the_chariot':
    require('../../../../../assets/cards/rws/the_chariot.png') as ImageSourcePropType,
  'rws/strength': require('../../../../../assets/cards/rws/strength.png') as ImageSourcePropType,
  'rws/the_hermit':
    require('../../../../../assets/cards/rws/the_hermit.png') as ImageSourcePropType,
  'rws/wheel_of_fortune':
    require('../../../../../assets/cards/rws/wheel_of_fortune.png') as ImageSourcePropType,
  'rws/justice': require('../../../../../assets/cards/rws/justice.png') as ImageSourcePropType,
  'rws/the_hanged_man':
    require('../../../../../assets/cards/rws/the_hanged_man.png') as ImageSourcePropType,
  'rws/death': require('../../../../../assets/cards/rws/death.png') as ImageSourcePropType,
  'rws/temperance':
    require('../../../../../assets/cards/rws/temperance.png') as ImageSourcePropType,
  'rws/the_devil': require('../../../../../assets/cards/rws/the_devil.png') as ImageSourcePropType,
  'rws/the_tower': require('../../../../../assets/cards/rws/the_tower.png') as ImageSourcePropType,
  'rws/the_star': require('../../../../../assets/cards/rws/the_star.png') as ImageSourcePropType,
  'rws/the_moon': require('../../../../../assets/cards/rws/the_moon.png') as ImageSourcePropType,
  'rws/the_sun': require('../../../../../assets/cards/rws/the_sun.png') as ImageSourcePropType,
  'rws/judgement': require('../../../../../assets/cards/rws/judgement.png') as ImageSourcePropType,
  'rws/the_world': require('../../../../../assets/cards/rws/the_world.png') as ImageSourcePropType,
};

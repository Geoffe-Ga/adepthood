// One require() per bundled RWS asset_key. Metro statically bundles only
// string-literal require paths, so this map is maintained explicitly (one
// entry per shipped image) rather than built from a loop.
//
// All 78 cards ship today — the 22 Major Arcana plus the 56 Minor Arcana,
// bundled via the same Wikimedia Commons pipeline. Keys are the full
// `asset_key` (`rws/<slug>`) so they line up 1:1 with RWS_CARDS in ./rws.
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
  // Minor Arcana — Wands
  'rws/ace_of_wands':
    require('../../../../../assets/cards/rws/ace_of_wands.png') as ImageSourcePropType,
  'rws/two_of_wands':
    require('../../../../../assets/cards/rws/two_of_wands.png') as ImageSourcePropType,
  'rws/three_of_wands':
    require('../../../../../assets/cards/rws/three_of_wands.png') as ImageSourcePropType,
  'rws/four_of_wands':
    require('../../../../../assets/cards/rws/four_of_wands.png') as ImageSourcePropType,
  'rws/five_of_wands':
    require('../../../../../assets/cards/rws/five_of_wands.png') as ImageSourcePropType,
  'rws/six_of_wands':
    require('../../../../../assets/cards/rws/six_of_wands.png') as ImageSourcePropType,
  'rws/seven_of_wands':
    require('../../../../../assets/cards/rws/seven_of_wands.png') as ImageSourcePropType,
  'rws/eight_of_wands':
    require('../../../../../assets/cards/rws/eight_of_wands.png') as ImageSourcePropType,
  'rws/nine_of_wands':
    require('../../../../../assets/cards/rws/nine_of_wands.png') as ImageSourcePropType,
  'rws/ten_of_wands':
    require('../../../../../assets/cards/rws/ten_of_wands.png') as ImageSourcePropType,
  'rws/page_of_wands':
    require('../../../../../assets/cards/rws/page_of_wands.png') as ImageSourcePropType,
  'rws/knight_of_wands':
    require('../../../../../assets/cards/rws/knight_of_wands.png') as ImageSourcePropType,
  'rws/queen_of_wands':
    require('../../../../../assets/cards/rws/queen_of_wands.png') as ImageSourcePropType,
  'rws/king_of_wands':
    require('../../../../../assets/cards/rws/king_of_wands.png') as ImageSourcePropType,
  // Minor Arcana — Cups
  'rws/ace_of_cups':
    require('../../../../../assets/cards/rws/ace_of_cups.png') as ImageSourcePropType,
  'rws/two_of_cups':
    require('../../../../../assets/cards/rws/two_of_cups.png') as ImageSourcePropType,
  'rws/three_of_cups':
    require('../../../../../assets/cards/rws/three_of_cups.png') as ImageSourcePropType,
  'rws/four_of_cups':
    require('../../../../../assets/cards/rws/four_of_cups.png') as ImageSourcePropType,
  'rws/five_of_cups':
    require('../../../../../assets/cards/rws/five_of_cups.png') as ImageSourcePropType,
  'rws/six_of_cups':
    require('../../../../../assets/cards/rws/six_of_cups.png') as ImageSourcePropType,
  'rws/seven_of_cups':
    require('../../../../../assets/cards/rws/seven_of_cups.png') as ImageSourcePropType,
  'rws/eight_of_cups':
    require('../../../../../assets/cards/rws/eight_of_cups.png') as ImageSourcePropType,
  'rws/nine_of_cups':
    require('../../../../../assets/cards/rws/nine_of_cups.png') as ImageSourcePropType,
  'rws/ten_of_cups':
    require('../../../../../assets/cards/rws/ten_of_cups.png') as ImageSourcePropType,
  'rws/page_of_cups':
    require('../../../../../assets/cards/rws/page_of_cups.png') as ImageSourcePropType,
  'rws/knight_of_cups':
    require('../../../../../assets/cards/rws/knight_of_cups.png') as ImageSourcePropType,
  'rws/queen_of_cups':
    require('../../../../../assets/cards/rws/queen_of_cups.png') as ImageSourcePropType,
  'rws/king_of_cups':
    require('../../../../../assets/cards/rws/king_of_cups.png') as ImageSourcePropType,
  // Minor Arcana — Swords
  'rws/ace_of_swords':
    require('../../../../../assets/cards/rws/ace_of_swords.png') as ImageSourcePropType,
  'rws/two_of_swords':
    require('../../../../../assets/cards/rws/two_of_swords.png') as ImageSourcePropType,
  'rws/three_of_swords':
    require('../../../../../assets/cards/rws/three_of_swords.png') as ImageSourcePropType,
  'rws/four_of_swords':
    require('../../../../../assets/cards/rws/four_of_swords.png') as ImageSourcePropType,
  'rws/five_of_swords':
    require('../../../../../assets/cards/rws/five_of_swords.png') as ImageSourcePropType,
  'rws/six_of_swords':
    require('../../../../../assets/cards/rws/six_of_swords.png') as ImageSourcePropType,
  'rws/seven_of_swords':
    require('../../../../../assets/cards/rws/seven_of_swords.png') as ImageSourcePropType,
  'rws/eight_of_swords':
    require('../../../../../assets/cards/rws/eight_of_swords.png') as ImageSourcePropType,
  'rws/nine_of_swords':
    require('../../../../../assets/cards/rws/nine_of_swords.png') as ImageSourcePropType,
  'rws/ten_of_swords':
    require('../../../../../assets/cards/rws/ten_of_swords.png') as ImageSourcePropType,
  'rws/page_of_swords':
    require('../../../../../assets/cards/rws/page_of_swords.png') as ImageSourcePropType,
  'rws/knight_of_swords':
    require('../../../../../assets/cards/rws/knight_of_swords.png') as ImageSourcePropType,
  'rws/queen_of_swords':
    require('../../../../../assets/cards/rws/queen_of_swords.png') as ImageSourcePropType,
  'rws/king_of_swords':
    require('../../../../../assets/cards/rws/king_of_swords.png') as ImageSourcePropType,
  // Minor Arcana — Pentacles
  'rws/ace_of_pentacles':
    require('../../../../../assets/cards/rws/ace_of_pentacles.png') as ImageSourcePropType,
  'rws/two_of_pentacles':
    require('../../../../../assets/cards/rws/two_of_pentacles.png') as ImageSourcePropType,
  'rws/three_of_pentacles':
    require('../../../../../assets/cards/rws/three_of_pentacles.png') as ImageSourcePropType,
  'rws/four_of_pentacles':
    require('../../../../../assets/cards/rws/four_of_pentacles.png') as ImageSourcePropType,
  'rws/five_of_pentacles':
    require('../../../../../assets/cards/rws/five_of_pentacles.png') as ImageSourcePropType,
  'rws/six_of_pentacles':
    require('../../../../../assets/cards/rws/six_of_pentacles.png') as ImageSourcePropType,
  'rws/seven_of_pentacles':
    require('../../../../../assets/cards/rws/seven_of_pentacles.png') as ImageSourcePropType,
  'rws/eight_of_pentacles':
    require('../../../../../assets/cards/rws/eight_of_pentacles.png') as ImageSourcePropType,
  'rws/nine_of_pentacles':
    require('../../../../../assets/cards/rws/nine_of_pentacles.png') as ImageSourcePropType,
  'rws/ten_of_pentacles':
    require('../../../../../assets/cards/rws/ten_of_pentacles.png') as ImageSourcePropType,
  'rws/page_of_pentacles':
    require('../../../../../assets/cards/rws/page_of_pentacles.png') as ImageSourcePropType,
  'rws/knight_of_pentacles':
    require('../../../../../assets/cards/rws/knight_of_pentacles.png') as ImageSourcePropType,
  'rws/queen_of_pentacles':
    require('../../../../../assets/cards/rws/queen_of_pentacles.png') as ImageSourcePropType,
  'rws/king_of_pentacles':
    require('../../../../../assets/cards/rws/king_of_pentacles.png') as ImageSourcePropType,
};

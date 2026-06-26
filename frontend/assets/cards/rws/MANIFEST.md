# Rider–Waite–Smith Tarot Artwork — Provenance Manifest

These PNGs back the Tarot and Card-Meditation practice modes (issue #467).
Each file is named by its card **slug**; the resolver maps the deck
`asset_key` (`rws/<slug>`) to the file in
`src/features/Practice/data/decks/rwsImages.ts`.

## Source & public-domain rationale

- **Deck:** the 1909 Rider–Waite–Smith Tarot, illustrated by Pamela Colman
  Smith, published by William Rider & Son (London).
- **Public-domain status (US):** the deck was published in **1909**, before
  the 1928 cutoff, so it is in the public domain in the United States. The
  scans below are the standard high-resolution reproductions hosted on
  Wikimedia Commons, tagged `PD-US` / `PD-1923` (now `PD-US-expired`).
- **Retrieved from:** Wikimedia Commons via
  `https://commons.wikimedia.org/wiki/Special:FilePath/RWS_Tarot_<NN>_<Name>.jpg`
  (e.g. `RWS_Tarot_00_Fool.jpg`).
- **Processing:** each source JPEG was resized to 500px wide, stripped of
  metadata, and quantized to an 8-bit palette PNG (ImageMagick) so every file
  stays under the repository's 250 KB asset budget while remaining crisp at
  card display sizes. No artwork was altered, retouched, or recomposed.

## Scope

All **78 cards** now ship: the 22 Major Arcana and the 56 Minor Arcana. The
Minor Arcana were bundled via the same Wikimedia Commons pipeline, sourced
from the `File:<Suit><NN>.jpg` plates (`Wands`, `Cups`, `Swords`, `Pents`,
numbered `01`–`14`). Commons "Pents" maps to the deck slug `pentacles`. Each
plate is the same 1909 Rider–Waite–Smith public-domain artwork described
above, resized to 500px wide, metadata-stripped, and palette-quantized so
every file stays under the 250 KB asset budget.

## Files (SHA-256, bytes)

| File                     | SHA-256                                                            | Size (bytes) |
| ------------------------ | ------------------------------------------------------------------ | ------------ |
| `death.png`              | `d399277448cb1a6b2d75540418f45d87db0103d01ab6e2087bfe9b421c22305f` | 240844       |
| `judgement.png`          | `e7c3684064a7c2b97cf2348d2c2148d0e525250c57037dd21b2a7bac42eb292f` | 240903       |
| `justice.png`            | `137bff5efb89e4e380382b7c0bd99b55716992a7ed75617a40f017e8f08e7205` | 235823       |
| `strength.png`           | `106607015cebc1fcab851a90b88b537816e5ca0f88cd2fb4408374c257d76e28` | 208312       |
| `temperance.png`         | `87581497c447410123df75f33be971d23372866ae5ead6db6314262a54654485` | 238783       |
| `the_chariot.png`        | `111577a31c5aeb102efce44e0527cead3e12ad3c5a98d3acb2b706b63f5f234d` | 234027       |
| `the_devil.png`          | `aa495e57833c47c969b475147059a8547f9a57bd08e05c1506d89929069ed3d9` | 214485       |
| `the_emperor.png`        | `b7b96af645659d350f563eb6132260e6fffc18b957b919442df98982c4ecee80` | 244363       |
| `the_empress.png`        | `401191645c6b3c428e260501aa7001fb8056ef1a7e57ecb449b852b041a35442` | 234451       |
| `the_fool.png`           | `9670f5d663745263c1ff25a60522917b74296bf5b19c9abe6da46bc776aa358e` | 207745       |
| `the_hanged_man.png`     | `93caeca37fa3eeb6607af4c39d1efd5027af6e52802754019f6dc621882ec0c4` | 236686       |
| `the_hermit.png`         | `637999a43bafb6aacdbe1cdb0ccce07a2b93ab0bc7c97e5ac4078ef7d5e2616e` | 194571       |
| `the_hierophant.png`     | `e2910ab954165f9a5213557c3679dab85406d885c29ca5c56104b314881863d5` | 236218       |
| `the_high_priestess.png` | `f409a786b3949ef8496b84f5b4cc1337f9dc3eb5d5bbddb0cdc4bf5de138dcc3` | 240251       |
| `the_lovers.png`         | `95ff479ed6d56690f6d6ddc3d3258a57ab987e82da9256de651b6e8c0c7370b4` | 242700       |
| `the_magician.png`       | `89d018fe6b3b9796c133d44513bded053981a9f72af08b60996c5cbdac2a2a00` | 209969       |
| `the_moon.png`           | `ab1b72b8cdf64fcde6236162367d7696cf6396cc983a741b2b6fb9f22a3799ab` | 222655       |
| `the_star.png`           | `83a1e7d3f76096a1548d966fbf1d8070c7bc56b87476ac8cc7ed7fdee59a4798` | 220742       |
| `the_sun.png`            | `0bab63f9f9065148cafd90c3d691ed500cda3a111710b46a31444c8c8273b3db` | 230833       |
| `the_tower.png`          | `91a8817b3699e825529003b0c986ffff56b7b82efafb8196fe0de2f3e7841fcd` | 200022       |
| `the_world.png`          | `a7ba0deb5bf4e67f157c959b07ebbad1ba61ee4427fd8c14d8f06329e9196af9` | 235050       |
| `wheel_of_fortune.png`   | `38a5a89451ce0da93959feaaac3432e1baf34d8c9b2b1b630c64cd3b7825c41f` | 233799       |

## Minor Arcana files (SHA-256, bytes)

Provenance: 1909 Rider–Waite–Smith, public domain (PD-US-expired),
retrieved from Wikimedia Commons. Commons source file is `File:<Prefix><NN>.jpg`
(suit prefixes `Wands`, `Cups`, `Swords`, `Pents`; numbers `01`–`14`).

### Wands (Commons `File:WandsNN.jpg`)

| File                  | SHA-256                                                            | Commons source     | Size (bytes) |
| --------------------- | ------------------------------------------------------------------ | ------------------ | ------------ |
| `ace_of_wands.png`    | `043436a5966860f85786699fe5a4345c0f6ad9e1f0b0c25b09b6da77b21c281a` | `File:Wands01.jpg` | 232877       |
| `two_of_wands.png`    | `c95f187c23be2763487f17e2dcffc40a1ed5988cbc2ef1c54dbc8535c05d7e2a` | `File:Wands02.jpg` | 242413       |
| `three_of_wands.png`  | `6aa9dd712983e5d131b1a1f6645c0078b52944b1a1281e44ee79b10cee5759c3` | `File:Wands03.jpg` | 234157       |
| `four_of_wands.png`   | `9208ea93657e8aca0c7aad83daae67ecbbf7100e1983d8ce89ee2b2ee142da96` | `File:Wands04.jpg` | 236984       |
| `five_of_wands.png`   | `8f1383396c5f344819b9cf7ee30b72dbb52ab487cc6468ce95d0d73449186369` | `File:Wands05.jpg` | 243274       |
| `six_of_wands.png`    | `f02108ca6f3146ee465b3c0edea1d6401b25d94575fa54fb3bbc1222148ff813` | `File:Wands06.jpg` | 247280       |
| `seven_of_wands.png`  | `808a9cb11c98cd11460366f0ac4c66d4b0b700710ac711b7457edc506d700d8d` | `File:Wands07.jpg` | 220325       |
| `eight_of_wands.png`  | `307085958b64682282de18eeac4415fd7a699944adcea391cfc1263951bdf526` | `File:Wands08.jpg` | 221859       |
| `nine_of_wands.png`   | `10222035845d252ca9828a466931458a431a0e59ca2a7bdfd4da49f0efb519b9` | `File:Wands09.jpg` | 247550       |
| `ten_of_wands.png`    | `a842ee18c8906e4799af37f37076eb540f1241a764fa0179dfc6aeccaaafc797` | `File:Wands10.jpg` | 243945       |
| `page_of_wands.png`   | `505875955c9ee3c6dc9a93972d6d482d3ad78c203a680c4ffe16a223cbc39717` | `File:Wands11.jpg` | 242087       |
| `knight_of_wands.png` | `9c82a573e8270281f5dda9bce46c2ce2e8317781b93ca5f61991ad6214c04f28` | `File:Wands12.jpg` | 245090       |
| `queen_of_wands.png`  | `6dfc15a00257c4aed338a11ba587e88f0fda5067b2e34e5f65fec6fee4f20ded` | `File:Wands13.jpg` | 244589       |
| `king_of_wands.png`   | `b30b34d1dc8b44d7f0ccec2654b0791040df1f12606bd9f354efaa8186d56444` | `File:Wands14.jpg` | 247390       |

### Cups (Commons `File:CupsNN.jpg`)

| File                 | SHA-256                                                            | Commons source    | Size (bytes) |
| -------------------- | ------------------------------------------------------------------ | ----------------- | ------------ |
| `ace_of_cups.png`    | `54447fa760246d431869171490d9f0a9d2a2570464565d7651e203228b1dfb94` | `File:Cups01.jpg` | 248853       |
| `two_of_cups.png`    | `dbc6af4e941a6a525c65d48893d3f29226ffa53f2b34a787564847b7e086b46f` | `File:Cups02.jpg` | 233600       |
| `three_of_cups.png`  | `b5161b5b4d8493e9fdf7cfed3b9b1ce32b7c96dbd37c267de1b934213fd8e32b` | `File:Cups03.jpg` | 229991       |
| `four_of_cups.png`   | `8a886b64b3a4a1c11811e16229fef1ab9bee2f6c1c3edc8901539fa602f31677` | `File:Cups04.jpg` | 232517       |
| `five_of_cups.png`   | `088e5329b044325dcde9a7280daea0807f0f39e831e1e61fe8ceed4eded1b103` | `File:Cups05.jpg` | 239007       |
| `six_of_cups.png`    | `988fadd4a14e0d6e817d7ab41cc159ba44d9bfb751fbba0199856aac8fa31440` | `File:Cups06.jpg` | 235783       |
| `seven_of_cups.png`  | `a989ed71d412ce6dccafaadba6167908df19362e337b406d8e8e59fe59d5bce1` | `File:Cups07.jpg` | 223882       |
| `eight_of_cups.png`  | `ce1b65a38bb3b93cd8ce1d6a898984e6faec369c9eec633ac354452ba908c697` | `File:Cups08.jpg` | 225521       |
| `nine_of_cups.png`   | `217d0115837589d5c430901907c462ec01896f915c25e71f5974041ba7f6ad18` | `File:Cups09.jpg` | 218524       |
| `ten_of_cups.png`    | `4f7c3cfb94600c5d75480c8437ff01e1e84ffba8d20df71ca348bb19a8b293ee` | `File:Cups10.jpg` | 240275       |
| `page_of_cups.png`   | `72df8a1cbea847063a06e5d1161725370385f92b86abf09117992e88b0e2e274` | `File:Cups11.jpg` | 244291       |
| `knight_of_cups.png` | `a6a48df9f25d1e0c9d69df96e5997314c5eacdffd6026426c95dc45643cb8d1e` | `File:Cups12.jpg` | 243688       |
| `queen_of_cups.png`  | `61cab7221d6a0462879a296e4bb11ea4a2dc5d2007853d848d7bb5f2a7699ee8` | `File:Cups13.jpg` | 233476       |
| `king_of_cups.png`   | `338e74dbf03df98f35928a28a5d69ffc08dc406cea74377bf0254d23a22312e0` | `File:Cups14.jpg` | 247444       |

### Swords (Commons `File:SwordsNN.jpg`)

| File                   | SHA-256                                                            | Commons source      | Size (bytes) |
| ---------------------- | ------------------------------------------------------------------ | ------------------- | ------------ |
| `ace_of_swords.png`    | `26f559be3b7ebf85a92b7f8cc18b3563df46bc7a46b41d3a5011f0d51ee8af20` | `File:Swords01.jpg` | 241308       |
| `two_of_swords.png`    | `a65c975f755590f54beed672132ef3a8b1d43a2b3707912d6f5349a0a91e7e87` | `File:Swords02.jpg` | 224237       |
| `three_of_swords.png`  | `b4c5dc447d0385b26ef4a47c235e7aa511d6e88719e41bdc4263825e0d99f2ed` | `File:Swords03.jpg` | 202879       |
| `four_of_swords.png`   | `d6d532c8b410f728287ed4ff4f6387f4be8061c5d0d477087a9af570291f39aa` | `File:Swords04.jpg` | 235464       |
| `five_of_swords.png`   | `535cb51fce20f5df3fa1dcec5404bbfcadcb133882b36dd8c57eeff9c013899c` | `File:Swords05.jpg` | 235422       |
| `six_of_swords.png`    | `a0bb0b4dcf392fe490f3757431c6661faa5d9cac164b8b071b4d26b45e21b8d9` | `File:Swords06.jpg` | 241464       |
| `seven_of_swords.png`  | `9178859b2ff157faffcaa9928c4c5517a6990c912ea7f21beb62d890ba41709f` | `File:Swords07.jpg` | 231601       |
| `eight_of_swords.png`  | `1fdfce05c9bca18f55b40c4b198157520916e79d361a22a20deffa0b061a99bb` | `File:Swords08.jpg` | 242901       |
| `nine_of_swords.png`   | `891ff75625a57fff2624173ef38899fdfd4300a42ec57545d404164756b6a174` | `File:Swords09.jpg` | 196126       |
| `ten_of_swords.png`    | `f9e38715d59ae7ce38b817a69279b91885ef38909244eebd1c9b6271720b957e` | `File:Swords10.jpg` | 188073       |
| `page_of_swords.png`   | `b60c9a96df2faae7cac516636af488ae21ff62ee8913dfff526ac5819afa5652` | `File:Swords11.jpg` | 249349       |
| `knight_of_swords.png` | `7045305b6526e32fcb2db7a3a131353976059019806cabf18f07df46f2055d70` | `File:Swords12.jpg` | 245038       |
| `queen_of_swords.png`  | `816ec315a14f647d7cd4d3f5b068cfec28bb554f2b29a7f75e3b1883da6190b2` | `File:Swords13.jpg` | 237704       |
| `king_of_swords.png`   | `2cfec542ffc27652c26df9bf0760932ef4ffa7f0313c5fae780c18b798b904f8` | `File:Swords14.jpg` | 245081       |

### Pentacles (Commons `File:PentsNN.jpg`)

| File                      | SHA-256                                                            | Commons source     | Size (bytes) |
| ------------------------- | ------------------------------------------------------------------ | ------------------ | ------------ |
| `ace_of_pentacles.png`    | `1a786a1e4daf713e42e82738298bcd9052f548b86e3d124481dac1c28e4f7308` | `File:Pents01.jpg` | 241297       |
| `two_of_pentacles.png`    | `6eca6c7fe2c0d4a2333fda1692b4313b7a22a342b4c8abf6aeba668a41f2ccb5` | `File:Pents02.jpg` | 243637       |
| `three_of_pentacles.png`  | `58887452566c6d49bbd1b798f0b204b5ac09108763ad578ba1d466c07c5e867d` | `File:Pents03.jpg` | 232806       |
| `four_of_pentacles.png`   | `39e2b6d0835adb9dadd81e2a714b45cdc2dce4fc88eecabb1d3bfa99f981e327` | `File:Pents04.jpg` | 220107       |
| `five_of_pentacles.png`   | `272232f361fe57cfa78b3dc136aa29b94696584dca1308bb0b5dd5283583e243` | `File:Pents05.jpg` | 224675       |
| `six_of_pentacles.png`    | `f23c2a40a7efe0cfda8824beb591aae14d56e991b97bcd5fc7efaf96e4e43b5a` | `File:Pents06.jpg` | 238321       |
| `seven_of_pentacles.png`  | `be2ad6e81ee1a7ee6eabd88b0926d1f26c17b53c0c7d33604057720020649ee9` | `File:Pents07.jpg` | 234411       |
| `eight_of_pentacles.png`  | `404b08715f4b283ba40651211050a29459f984c8f429aec6c85edb6672cb3172` | `File:Pents08.jpg` | 241601       |
| `nine_of_pentacles.png`   | `e5f1b0cfc001aaa1a9023b579e7e5c8d49e5d49ab45d318d94b481b77c46c24a` | `File:Pents09.jpg` | 233205       |
| `ten_of_pentacles.png`    | `4a7cb2f73d9960cde00eebe1ce66b18705bdd2898c31b6d39e435f5201ea94d4` | `File:Pents10.jpg` | 244211       |
| `page_of_pentacles.png`   | `589049408e6e7630c99102ade9cf5bf89148a90bffebfa4c2f5337194f2b2b72` | `File:Pents11.jpg` | 227216       |
| `knight_of_pentacles.png` | `bf26c8166b1b7c72dea5072e355d29719f3f88721c8b869ed0556200c4d0e7ce` | `File:Pents12.jpg` | 202607       |
| `queen_of_pentacles.png`  | `2eb4668d565b8d65aa60272a61b4b4d81b5038444804e9767460e88b21487714` | `File:Pents13.jpg` | 236534       |
| `king_of_pentacles.png`   | `1582e329c5c3ea8831acd27d4ec53ad96955bbbcd2df58ad1a71281fb7b2c305` | `File:Pents14.jpg` | 222755       |

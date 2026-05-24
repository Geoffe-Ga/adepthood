"""Long-form ``description`` and ``instructions`` text for the catalog presets.

Split from :mod:`seed_practices` so the seeder logic stays small and the
product-editable copy lives in a flat, diff-friendly data module.

Each entry maps a preset *name* to a ``(description, instructions)`` tuple.
Keying by name (rather than stage number) lets a single stage carry more
than one preset — e.g. the stage-1 grounding alternatives. Lengths stay
under the ``Practice`` model's column caps
(description ≤ 2000 chars, instructions ≤ 10000 chars).
"""

from __future__ import annotations

#: Stage 1 — 5-4-3-2-1 sensory grounding (sense_grounding mode).
_S1 = (
    "A grounding technique that anchors you in the present by inventorying "
    "what each sense is reporting right now.",
    "Sit or stand. For each sense in order, name the listed number of "
    "specific things you can perceive — out loud or in your head. Move on "
    "to the next sense only when you've completed the current one. "
    "Five things you can see, four you can touch, three you can hear, "
    "two you can smell, one you can taste.",
)

#: Stage 2 — Tarot meditation on the major arcana (tarot mode).
_S2 = (
    "Sit with one card of the Major Arcana per day for five minutes, "
    "progressing from The Fool to The World over 22 days.",
    "Find a quiet seat. Bring the card to mind (or place it before you) "
    "and let the image speak. Do not analyse — observe what arises in "
    "body, feeling, and thought. The timer is hidden during the meditation "
    "so you can rest in the image; it reappears at the bell.",
)

#: Stage 3 — Belly breathing (meditation_timer).
_S3 = (
    "Ten minutes of diaphragmatic breathing to settle the nervous system.",
    "Sit upright with one hand on the belly. Inhale slowly through the "
    "nose, feeling the hand rise as the diaphragm drops. Exhale through "
    "pursed lips, twice as long as the inhale if comfortable. Continue "
    "until the closing bell.",
)

#: Stage 4 — Metta / loving-kindness (meditation_timer).
_S4 = (
    "Fifteen minutes of loving-kindness practice across widening circles.",
    "Begin with yourself. Silently offer the four phrases — may I be safe, "
    "may I be happy, may I be healthy, may I live with ease. When the "
    "halfway bell sounds, widen to someone you love, then to a neutral "
    "person, then to someone difficult, then to all beings.",
)

#: Stage 5 — Wim Hof method (meditation_timer).
_S5 = (
    "Twenty minutes of cyclic hyperventilation with retention rounds, followed by quiet rest.",
    "Take 30-40 deep, full breaths in through the nose or mouth, exhaling "
    "passively. After the final exhale, hold without breath until the "
    "natural urge returns; then inhale fully and hold for 15 seconds. "
    "Repeat three rounds, then rest in the stillness that follows.",
)

#: Stage 6 — Shadow work with metronome (metronome mode).
_S6 = (
    "Thirty minutes of shadow-confronting reflection paced by a metronome.",
    "Set an intention to meet a part of yourself you usually turn away "
    "from. Let the metronome's tick keep you from drifting into "
    "rumination — each click is a return to bare attention. When the "
    "halfway bell sounds, ask what this part wants you to know.",
)

#: Stage 7 — Blissy meditation (meditation_timer).
_S7 = (
    "Forty-five minutes resting in the field of subtle pleasure.",
    "Sit comfortably. Locate any background sensation of contentment, "
    "ease, or pleasantness — however faint. Rest attention there, letting "
    "the feeling broaden by being noticed rather than chased.",
)

#: Stage 8 — Dog Walkin' Shamanism (count_up).
_S8 = (
    "An open-ended walking practice: take the dog (or yourself) out, "
    "and let the world's signs speak.",
    "Walk without a destination. Notice what catches your attention — a "
    "bird, a license plate, a colour, a phrase overheard. Treat each as a "
    "message worth holding lightly. End when you feel complete; the timer "
    "counts up to honour the open container.",
)

#: Stage 9 — Concentration practice (meditation_timer).
_S9 = (
    "Forty-five minutes single-pointed attention on one object.",
    "Choose a single object — breath at the nostrils, a kasina, or a "
    "phrase. When you notice the mind has wandered, return without "
    "comment. The halfway bell is your invitation to refresh the choice.",
)

#: Stage 10 — Insight practice (meditation_timer).
_S10 = (
    "Forty-five minutes of open awareness, watching the three characteristics arise and pass.",
    "Begin grounded in the body. Open the field to whatever is present — "
    "sensation, sound, thought — and notice how each arises, persists, "
    "and dissolves. The work is not to control but to see clearly.",
)


#: Stage 1 alternative — Touch Grass (mindful_anchor mode).
_TOUCH_GRASS = (
    "A single-action grounding practice: stand barefoot on a natural "
    "surface and let its texture and temperature draw you into the "
    "present moment.",
    "Find a patch of grass, soil, sand, or stone where you can safely "
    "stand barefoot. Take off your shoes. Plant both feet and let your "
    "weight settle. Notice the texture, the temperature, and the pressure "
    "where your soles meet the earth. There is nothing to accomplish — "
    "stay until you feel settled, then mark the practice complete.",
)

#: Stage 1 alternative — Mindful Eating (mindful_anchor mode).
_MINDFUL_EATING = (
    "A single-action mindful-presence practice: eat one small portion of "
    "a grounding food slowly, giving full attention to every sense.",
    "Choose one small portion of a grounding food and sit down with it. "
    "Before the first bite, take in its colour, shape, and aroma. Eat "
    "slowly: attend to texture, temperature, and flavour, and pause "
    "between bites to let each one finish. When the portion is gone, sit "
    "with the aftertaste for a moment before marking the practice complete.",
)

#: Stage 1 alternative — Find Shapes (tallied_grounding mode).
_FIND_SHAPES = (
    "A grounding technique that anchors you in the present by hunting "
    "your surroundings for everyday geometric shapes.",
    "Look around wherever you are. Each round, find three squares, then "
    "three triangles, then three circles — pointing to or naming each "
    "one as you spot it. Finish all three shapes before starting the "
    "next round. Three rounds in all.",
)

#: Stage 1 alternative — Find Colors (tallied_grounding mode).
_FIND_COLORS = (
    "A grounding technique that anchors you in the present by sweeping "
    "your surroundings for each colour of the rainbow.",
    "Look around wherever you are. Each round, find one thing for every "
    "colour of the rainbow in order — red, orange, yellow, green, blue, "
    "indigo, violet — naming each as you spot it. Finish the full "
    "spectrum before starting the next round. Three rounds in all.",
)


# -- Stage 1 BEIGE alternatives — body-grounding / nervous-system regulation -


#: Stage 1 alternative — Crystal Charging (meditation_timer mode).
_CRYSTAL_CHARGING = (
    "Five minutes of standing outdoors holding a stone or crystal, letting "
    "the contact between your palms, the object, and the earth bring you "
    "back to the moment.",
    "Choose any stone, crystal, or smooth pebble you can hold in one "
    "cupped palm. Step outside and stand barefoot on grass, soil, sand, "
    "or stone. Close your fingers gently around the object and notice "
    "its weight, temperature, and texture. Let your attention travel "
    "between the object in your hand and the ground under your feet. "
    "When the bell sounds, lower the stone and open your hands.",
)

#: Stage 1 alternative — Tense and Release (meditation_timer mode).
_TENSE_AND_RELEASE = (
    "A clench-and-release body scan that drains residual tension by "
    "tightening each muscle group on purpose, then letting it go.",
    "Sit or lie comfortably. Beginning at the feet, tense the muscles "
    "there for a slow count of five, then release on the exhale and "
    "notice the change. Move up the body in turn — calves, thighs, "
    "glutes, belly, chest, hands, arms, shoulders, face. When the "
    "halfway bell sounds, you should be reaching the upper body. "
    "Finish at the crown and rest in the residual softness until the "
    "closing bell.",
)

#: Stage 1 alternative — Contact Points (meditation_timer mode).
_CONTACT_POINTS = (
    "A five-minute somatic inventory of every point where your body "
    "meets a surface, from soles to seat to skin against fabric.",
    "Sit or lie in any comfortable position. Without moving, scan "
    "slowly for each place your body touches something — chair, floor, "
    "clothing, the air on your skin. Name each contact silently as you "
    "find it: 'seat of pants,' 'left heel,' 'right palm.' When you "
    "reach the end of the inventory, start again. Stay with the survey "
    "until the closing bell.",
)

#: Stage 1 alternative — Box Breathing (meditation_timer mode).
_BOX_BREATHING = (
    "Five minutes of square-shaped breathing — inhale, hold, exhale, "
    "hold — to steady the breath and the nervous system.",
    "Sit upright with your hands resting on your thighs. Inhale through "
    "the nose for a slow count of four. Hold the breath for four. "
    "Exhale through the nose for four. Hold the empty lungs for four. "
    "Continue the pattern, easing back to a softer count if the holds "
    "feel forced. The halfway bell marks the midpoint.",
)

#: Stage 1 alternative — Toe Wiggling (meditation_timer mode).
_TOE_WIGGLING = (
    "A three-minute foot-attention practice: feel the weight of each "
    "foot, then wake them up by slowly wiggling each toe in turn.",
    "Take off your shoes if you can. Sit or stand with both feet flat "
    "on the floor. Bring attention to the sole of the left foot — the "
    "heel, the arch, the ball, each toe. Wiggle each toe slowly, one "
    "at a time, then all together. Repeat on the right foot. When the "
    "bell sounds, plant both feet and notice the difference.",
)

#: Stage 1 alternative — Body Scan (meditation_timer mode).
_BODY_SCAN = (
    "A five-minute top-down sweep of attention through the body, "
    "noticing whatever is present at each region without trying to "
    "change it.",
    "Sit or lie comfortably and close the eyes. Begin at the toes and "
    "move attention slowly upward — feet, ankles, calves, knees, "
    "thighs, hips, belly, chest, hands, arms, shoulders, neck, face, "
    "crown. At each region, pause for a breath and notice whatever "
    "sensation is present without trying to change it. The halfway "
    "bell marks the belly; finish at the crown by the closing bell.",
)

#: Stage 1 alternative — Progressive Muscle Relaxation (meditation_timer mode).
_PROGRESSIVE_MUSCLE_RELAXATION = (
    "Ten minutes of Jacobson's progressive muscle relaxation — "
    "sequentially tensing and releasing every major muscle group to "
    "invite deep rest.",
    "Lie down if you can. Beginning with the feet, tense the muscles "
    "there hard for five seconds, then release sharply on the exhale "
    "and rest for ten before moving on. Work through the entire body "
    "— calves, thighs, glutes, belly, chest, arms, hands, shoulders, "
    "neck, jaw, face. The halfway bell signals you should be reaching "
    "the torso. End with a whole-body tense-and-release before the "
    "closing bell.",
)


# -- Stage 2 PURPLE alternatives — divination / symbolic intuition -----------


#: Stage 2 alternative — Traffic Lights (meditation_timer mode).
_TRAFFIC_LIGHTS = (
    "A divinatory micro-practice: read your environment as if every "
    "traffic light were giving you a yes, no, or wait.",
    "Sit somewhere with a window onto a road, or close your eyes and "
    "visualise an intersection. Hold a single question. As each light "
    "turns — red for no, green for yes, yellow for not yet — read the "
    "colour as a response. Watch a sequence of three to five lights "
    "and let the pattern speak. Stay with the question until the bell.",
)

#: Stage 2 alternative — I Ching Toss (meditation_timer mode).
_I_CHING_TOSS = (
    "Ten minutes of toss-and-reflect divination using three coins and a meditative journal.",
    "Sit upright with three coins cupped in your palms and a notebook "
    "within reach. Bring a single question to mind. Cast the coins six "
    "times, recording the heads-or-tails sum each round to build a "
    "hexagram from the bottom line up. Look up the resulting hexagram "
    "and let the line readings reach you slowly. The halfway bell is "
    "your cue to put the book down and journal what the hexagram is "
    "asking of you.",
)

#: Stage 2 alternative — Bibliomancy (meditation_timer mode).
_BIBLIOMANCY = (
    "Open a book at random and read the first passage that lands as "
    "a reply to whatever question you bring.",
    "Pick any book of weight — poetry, scripture, a beloved novel — "
    "and rest it on your lap. Sit upright, settle the breath, and "
    "hold a single question in mind. Open the book at random and let "
    "your gaze fall on a passage without searching. Read it once "
    "slowly, then sit with the passage's resonance until the bell.",
)

#: Stage 2 alternative — Synchronicity Sweep (meditation_timer mode).
_SYNCHRONICITY_SWEEP = (
    "A five-minute meditative review of the day's coincidences — "
    "names, numbers, repeated images — to see what pattern is emerging.",
    "Sit upright and close the eyes. Sweep back through the day and "
    "gather every coincidence you noticed: a phrase heard twice, a "
    "number that kept appearing, a face that reminded you of someone. "
    "Hold each in turn without forcing meaning, then ask what the "
    "cluster is pointing toward. Stay with the inquiry until the bell.",
)

#: Stage 2 alternative — Trataka Candle Gazing (meditation_timer mode).
_TRATAKA = (
    "Ten minutes of soft, unblinking gaze on a candle flame, letting "
    "intuitive imagery rise from the inner field.",
    "Light a candle at eye level, an arm's length away. Sit upright "
    "and rest your gaze on the flame without straining; blink only "
    "when you must. After several minutes, close the eyes and watch "
    "the afterimage settle into the dark. The halfway bell is your "
    "cue to soften the gaze further or close the eyes if dryness "
    "sets in.",
)

#: Stage 2 alternative — Dream Recollection (meditation_timer mode).
_DREAM_RECOLLECTION = (
    "Ten minutes of slow, attentive recollection of last night's "
    "dreams, mapping the symbols that recurred.",
    "Sit upright with a notebook within reach. Close the eyes and "
    "travel backward into last night's sleep, surfacing whatever "
    "images, settings, characters, or moods you can. Write each "
    "fragment as it arrives without trying to order them. After the "
    "halfway bell, look across the page for symbols that repeat or "
    "echo and underline them.",
)

#: Stage 2 alternative — Archetypal Mantra (meditation_timer mode).
_ARCHETYPAL_MANTRA = (
    "Ten minutes of repetition of a single archetypal name — Hekate, "
    "Lakshmi, Kuan Yin — as a doorway to that quality.",
    "Choose one archetypal name that calls to you and sit upright "
    "with your hands resting on your thighs. Repeat the name silently "
    "on the exhale, letting the figure's quality — wisdom, abundance, "
    "mercy — settle into the body. The halfway bell is your invitation "
    "to ask what they would offer or what they would ask of you. "
    "Return to the name until the closing bell.",
)

#: Stage 2 alternative — Totem Meditation (meditation_timer mode).
_TOTEM_MEDITATION = (
    "Five minutes of attention on a personal totem — an animal, an "
    "object, a symbol — that has carried meaning across your life.",
    "Bring to mind a personal totem you have felt connected to — an "
    "animal, a stone, an inherited object, a recurring symbol. Hold "
    "it in attention, or in your hands if it is physical. Notice "
    "every feature you can — colour, shape, texture, the memories "
    "braided into it. When you feel met by the totem, rest with "
    "that meeting until the bell.",
)


# -- Stage 3 RED alternatives — energy / power -------------------------------


#: Stage 3 alternative — Hand Energy Sensing (meditation_timer mode).
_HAND_ENERGY_SENSING = (
    "Five minutes of generating warmth between your palms and tracking "
    "the field that arises between them.",
    "Sit upright with your hands free. Rub your palms together briskly "
    "for thirty seconds until they feel hot. Slowly draw them apart to "
    "a few inches and notice the sensation between them — pressure, "
    "tingling, warmth, weight. Play with the gap, moving the hands "
    "closer and further, and rest your attention on whatever you feel "
    "between them until the bell.",
)

#: Stage 3 alternative — Windhorse Breathwork (meditation_timer mode).
_WINDHORSE_BREATHWORK = (
    "Ten minutes of vigorous, rhythmic breathing from the Tibetan Bön "
    "tradition to stoke the inner fire (lung-ta).",
    "Sit upright on a cushion or chair. Take deep, full breaths through "
    "the nose, pressing the diaphragm out on the inhale and drawing it "
    "in on the exhale, at roughly one breath every two seconds. Imagine "
    "each inhale stoking a small flame at your navel. Ease off and "
    "breathe normally if you feel lightheaded or dizzy. After the "
    "halfway bell, return to natural breath and rest in the heat "
    "you have generated until the closing bell.",
)

#: Stage 3 alternative — Water Charging (meditation_timer mode).
_WATER_CHARGING = (
    "Five minutes of focused intention into a glass of water — adapted "
    "from Damien Echols's magickal water-charging technique.",
    "Pour a glass of water and hold it in both hands at chest level. "
    "Sit upright and close your eyes. Bring a single intention to mind "
    "— health, focus, courage. Imagine the intention flowing from your "
    "heart down your arms, through your palms, and into the water as "
    "a faint coloured light. Continue until the bell, then drink the "
    "water in slow sips.",
)

#: Stage 3 alternative — Mini TED Talk (meditation_timer mode).
_MINI_TED_TALK = (
    "Ten minutes of speaking aloud, uninterrupted, on something you "
    "genuinely know well — to anchor your authority in your own voice.",
    "Stand or sit upright in a private space. Choose one topic you "
    "have real expertise on — a craft, a book, a story you have told "
    "before. Speak aloud or sub-vocalize as if presenting to a small "
    "room, in continuous sentences without notes. If you trail off, "
    "restart from any point that brings the energy back. Keep speaking "
    "until the bell.",
)

#: Stage 3 alternative — Power Posture (meditation_timer mode).
_POWER_POSTURE = (
    "Ten minutes of holding an expansive posture — chest open, feet "
    "planted — paired with steady breath.",
    "Stand or sit with feet planted shoulder-width apart. Lift the "
    "crown, drop the shoulders, open the chest, and let the hands "
    "rest at the hips or on the thighs. Breathe in slowly through the "
    "nose, out slowly through the nose, with each breath reinforcing "
    "the posture. Hold the shape — not rigidly, but consciously — "
    "until the closing bell.",
)

#: Stage 3 alternative — Mountain Pose Sit (meditation_timer mode).
_MOUNTAIN_POSE_SIT = (
    "Ten minutes of seated mountain-pose visualization — embodying "
    "the immovable as a felt sense in the body.",
    "Sit cross-legged or in a chair with both feet flat. Imagine "
    "yourself as a mountain: broad at the base, weighted, unmoved by "
    "any weather. Silently repeat 'I cannot be moved' on each exhale. "
    "When thoughts or restlessness arise, let them pass across you "
    "like clouds rather than push them away. Stay with the mountain "
    "until the bell.",
)

#: Stage 3 alternative — Fire Gazing (meditation_timer mode).
_FIRE_GAZING = (
    "Ten minutes of soft gaze into a candle flame or hearth fire, "
    "anchoring attention down into the solar plexus.",
    "Light a candle or sit safely in front of a fire at eye level. "
    "Rest your gaze on the flame without straining, blinking only "
    "when needed. Drop attention from the eyes down into the solar "
    "plexus, as if the warmth above were also burning there. If your "
    "eyes water or you feel lightheaded, close them and stay with the "
    "heat in the belly. The halfway bell is your cue to soften the "
    "gaze.",
)

#: Stage 3 alternative — Warrior Stillness (meditation_timer mode).
_WARRIOR_STILLNESS = (
    "Ten minutes of holding a single warrior-style posture — without "
    "movement, without escape — to meet the discomfort that arises.",
    "Choose one posture you can hold for several minutes — warrior I "
    "or II, horse stance, low squat, plank. Take the shape with as "
    "much precision as you can manage. Breathe slowly through the nose "
    "and meet whatever sensations arise — burn, tremor, fatigue — "
    "without shifting out. If the posture becomes unsafe, lower out of "
    "it and resume the same posture from a gentler angle until the bell.",
)

#: Stage 3 alternative — Red Sphere Visualization (meditation_timer mode).
_RED_SPHERE_VISUALIZATION = (
    "Ten minutes of visualizing a pulsing red sphere of light at the "
    "gut to gather and concentrate vital energy.",
    "Sit upright with the eyes closed. Place attention at the centre "
    "of the belly, two finger-widths below the navel. Picture a small "
    "sphere of warm red light pulsing there with each breath — brighter "
    "on the inhale, steadier on the exhale. The halfway bell is your "
    "cue to let the sphere widen until it fills the whole abdomen. "
    "Hold the image until the closing bell.",
)

#: Stage 3 alternative — Love to Past Selves (meditation_timer mode).
_LOVE_TO_PAST_SELVES = (
    "Fifteen minutes of directing lovingkindness toward yourself at "
    "progressively younger ages — a self-reparenting practice.",
    "Sit comfortably with the eyes closed. Begin with your present "
    "self — silently offer 'may you be safe, may you feel held, may "
    "you know you are loved.' Then step backward in time: yourself "
    "at twenty-five, fifteen, ten, five, two, in the womb. Offer the "
    "same phrases at each age, lingering as long as feels right. "
    "After the halfway bell, take a few breaths and re-emerge into "
    "the present, offering the phrases one last time.",
)


# -- Stage 4 BLUE alternatives — heart / lovingkindness ----------------------


#: Stage 4 alternative — Tonglen (meditation_timer mode).
_TONGLEN = (
    "Fifteen minutes of the Tibetan giving-and-taking practice: inhale "
    "another being's pain, exhale ease and warmth toward them.",
    "Sit upright with the eyes closed. Bring to mind someone who is "
    "suffering. On each inhale, draw the discomfort of that being into "
    "your heart as warm dark smoke; on each exhale, send cool clear "
    "light of ease back toward them. After the halfway bell, widen "
    "the circle to all beings carrying the same kind of pain. Continue "
    "the breath rhythm until the closing bell.",
)

#: Stage 4 alternative — I Am Love Through (meditation_timer mode).
_I_AM_LOVE_THROUGH = (
    "Fifteen minutes of Selig's transmission phrase: 'I am Love "
    "through [name]' — letting love move through you toward a chosen "
    "other.",
    "Sit upright and close the eyes. Bring to mind one person you "
    "care for. Silently repeat the phrase 'I am Love through "
    "[their name]' on each exhale, letting the word Love be a felt "
    "current that moves out from your heart toward them. After the "
    "halfway bell, choose a second person and continue. Stay with "
    "the transmission until the closing bell.",
)

#: Stage 4 alternative — Heart Centered Breath (meditation_timer mode).
_HEART_CENTERED_BREATH = (
    "Fifteen minutes of breathing as if the breath itself moved through "
    "the centre of the chest rather than the nose.",
    "Sit upright with one or both hands resting on the centre of the "
    "chest. Imagine that you inhale through the heart and exhale "
    "through the heart, with the nose merely passing the air along. "
    "Let the breath grow slow and full. After the halfway bell, "
    "soften the hands and let the heart breathe on its own until the "
    "closing bell.",
)

#: Stage 4 alternative — Animist Gratitude (meditation_timer mode).
_ANIMIST_GRATITUDE = (
    "Ten minutes of speaking thanks aloud to the local beings — "
    "trees, birds, weather, land — that share your place.",
    "Step outside or sit near a window with the eyes open. Choose "
    "one local being at a time — a tree, a particular bird, the wind, "
    "the soil under your feet. Speak a sentence of thanks aloud, "
    "naming what you're grateful for. Move to the next being only "
    "when the first feels acknowledged. Continue addressing local "
    "beings until the bell.",
)

#: Stage 4 alternative — Hug Visualization (meditation_timer mode).
_HUG_VISUALIZATION = (
    "Ten minutes of vividly imagining a long, warm embrace with someone you miss.",
    "Sit comfortably with the eyes closed. Bring to mind one person "
    "you miss — living or gone. Picture them stepping in close and "
    "the two of you wrapping into a long, full-body embrace. Notice "
    "the weight, the temperature, the smell, the silence. Stay in the "
    "hug as long as it lasts, then begin again. Continue until the "
    "bell.",
)

#: Stage 4 alternative — Relational Gratitude (meditation_timer mode).
_RELATIONAL_GRATITUDE = (
    "Fifteen minutes of gratitude practice focused on the people in "
    "your life — naming specifically what each one gives you.",
    "Sit upright with the eyes closed. Bring to mind one person in "
    "your life and name silently what they specifically give you — "
    "humour, patience, presence, a particular kindness. Linger on "
    "the feeling of receiving it before moving to the next person. "
    "After the halfway bell, widen the circle to include those who "
    "have given less knowingly. Continue until the closing bell.",
)

#: Stage 4 alternative — Blessing Strangers (meditation_timer mode).
_BLESSING_STRANGERS = (
    "Ten minutes of silently blessing strangers while people-watching "
    "in a public space — done with the eyes open.",
    "Sit in a café, on a park bench, or in any public space with "
    "people moving past. Keep your eyes open and soft. As each "
    "stranger crosses your gaze, silently offer one phrase to them "
    "— 'may you be well,' 'may you be free of pain,' 'may you be "
    "loved.' Move on as soon as the phrase is given. Continue blessing "
    "passers-by until the bell.",
)

#: Stage 4 alternative — Heart Imagery (meditation_timer mode).
_HEART_IMAGERY = (
    "Fifteen minutes of meditation on a symbolic heart image — a "
    "green rose, a spiral, a chalice — letting the image speak.",
    "Sit upright with the eyes closed. Choose one heart-symbol that "
    "calls to you — a green rose, a spiral of light, a golden chalice. "
    "Place the image at the centre of your chest and watch it without "
    "trying to fix or interpret it. Notice colour, motion, sound, "
    "scent that arises with it. After the halfway bell, let the image "
    "soften and broaden. Stay with it until the closing bell.",
)

#: Stage 4 alternative — Just Like Me (meditation_timer mode).
_JUST_LIKE_ME = (
    "Fifteen minutes of repeating the phrase 'just like me, this being "
    "seeks happiness' toward a widening circle of others.",
    "Sit upright with the eyes closed. Bring to mind one specific "
    "being — easy, neutral, then difficult. For each, silently offer "
    "'just like me, this being seeks happiness; just like me, this "
    "being wants to be free from suffering.' Let the recognition land "
    "as a felt sense rather than a thought. After the halfway bell, "
    "widen to all beings everywhere. Continue until the closing bell.",
)

#: Stage 4 alternative — Ancestral Connection (meditation_timer mode).
_ANCESTRAL_CONNECTION = (
    "Fifteen minutes of reaching backward through the lineage with "
    "gratitude or lovingkindness toward those who came before.",
    "Sit upright with the eyes closed. Place attention behind you, "
    "as if a long line of ancestors stood at your back. Silently "
    "thank them by name where you know them, and by relation where "
    "you don't — grandmothers, grandfathers, the unnamed. Offer "
    "lovingkindness in their direction. After the halfway bell, let "
    "their presence settle into your back and shoulders, and rest "
    "in the felt support until the closing bell.",
)


PRESET_COPY: dict[str, tuple[str, str]] = {
    "5-4-3-2-1 grounding": _S1,
    "Tarot meditation": _S2,
    "Belly breathing": _S3,
    "Metta": _S4,
    "Wim Hof method": _S5,
    "Shadow work": _S6,
    "Blissy meditation": _S7,
    "Dog Walkin' Shamanism": _S8,
    "Concentration practice": _S9,
    "Insight practice": _S10,
    "Touch Grass": _TOUCH_GRASS,
    "Mindful Eating": _MINDFUL_EATING,
    "Find Shapes": _FIND_SHAPES,
    "Find Colors": _FIND_COLORS,
    "Crystal Charging": _CRYSTAL_CHARGING,
    "Tense and Release": _TENSE_AND_RELEASE,
    "Contact Points": _CONTACT_POINTS,
    "Box Breathing": _BOX_BREATHING,
    "Toe Wiggling": _TOE_WIGGLING,
    "Body Scan": _BODY_SCAN,
    "Progressive Muscle Relaxation": _PROGRESSIVE_MUSCLE_RELAXATION,
    "Traffic Lights": _TRAFFIC_LIGHTS,
    "I Ching Toss": _I_CHING_TOSS,
    "Bibliomancy": _BIBLIOMANCY,
    "Synchronicity Sweep": _SYNCHRONICITY_SWEEP,
    "Trataka Candle Gazing": _TRATAKA,
    "Dream Recollection": _DREAM_RECOLLECTION,
    "Archetypal Mantra": _ARCHETYPAL_MANTRA,
    "Totem Meditation": _TOTEM_MEDITATION,
    "Hand Energy Sensing": _HAND_ENERGY_SENSING,
    "Windhorse Breathwork": _WINDHORSE_BREATHWORK,
    "Water Charging": _WATER_CHARGING,
    "Mini TED Talk": _MINI_TED_TALK,
    "Power Posture": _POWER_POSTURE,
    "Mountain Pose Sit": _MOUNTAIN_POSE_SIT,
    "Fire Gazing": _FIRE_GAZING,
    "Warrior Stillness": _WARRIOR_STILLNESS,
    "Red Sphere Visualization": _RED_SPHERE_VISUALIZATION,
    "Love to Past Selves": _LOVE_TO_PAST_SELVES,
    "Tonglen": _TONGLEN,
    "I Am Love Through": _I_AM_LOVE_THROUGH,
    "Heart Centered Breath": _HEART_CENTERED_BREATH,
    "Animist Gratitude": _ANIMIST_GRATITUDE,
    "Hug Visualization": _HUG_VISUALIZATION,
    "Relational Gratitude": _RELATIONAL_GRATITUDE,
    "Blessing Strangers": _BLESSING_STRANGERS,
    "Heart Imagery": _HEART_IMAGERY,
    "Just Like Me": _JUST_LIKE_ME,
    "Ancestral Connection": _ANCESTRAL_CONNECTION,
}

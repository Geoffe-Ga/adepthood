"""Seed data for 36 weekly reflection prompts across the APTITUDE program.

Weeks are grouped by developmental stage:
  Weeks 1-3:   Beige (Survival / Grounding)
  Weeks 4-6:   Purple (Belonging / Tribe)
  Weeks 7-9:   Red (Power / Agency)
  Weeks 10-12: Blue (Order / Structure)
  Weeks 13-15: Orange (Achievement / Strategy)
  Weeks 16-18: Green (Community / Empathy)
  Weeks 19-21: Yellow (Integration / Systems)
  Weeks 22-24: Turquoise (Holistic / Global)
  Weeks 25-27: Coral (Transcendence / Purpose)
  Weeks 28-30: Teal (Adaptive / Flow)
  Weeks 31-33: Indigo (Depth / Contemplation)
  Weeks 34-36: Ultraviolet (Mastery / Contribution)
"""

from __future__ import annotations

WEEKLY_PROMPTS: dict[int, str] = {
    # Beige — Survival / Grounding
    1: ("What does safety mean to you right now? Describe a moment today when you felt grounded."),
    2: ("What basic needs are you neglecting? How does your body signal when something is off?"),
    3: ("Reflect on your relationship with rest. When do you allow yourself to truly stop?"),
    # Purple — Belonging / Tribe
    4: ("Who are the people that make you feel you belong? What do you offer them in return?"),
    5: ("Describe a ritual or tradition that connects you to something larger than yourself."),
    6: ("When have you felt most at home in a group? What made that experience meaningful?"),
    # Red — Power / Agency
    7: ("Where in your life do you feel powerful? Where do you feel powerless?"),
    8: ("Describe a time you stood up for yourself. What did it cost you? What did it give you?"),
    9: ("What anger or frustration are you carrying? What is it trying to protect?"),
    # Blue �� Order / Structure
    10: ("What rules or structures help you thrive? Which ones feel like they hold you back?"),
    11: (
        "Reflect on a commitment you have kept faithfully. "
        "What gives you the discipline to maintain it?"
    ),
    12: (
        "How do you define integrity? Where does your life "
        "align with that definition, and where does it fall short?"
    ),
    # Orange — Achievement / Strategy
    13: (
        "What goal are you pursuing right now? Is it truly yours, or inherited from someone else?"
    ),
    14: (
        "Describe your relationship with success. "
        "When does ambition serve you, and when does it consume you?"
    ),
    15: (
        "What would you attempt if you knew you could not fail? "
        "What stops you from attempting it anyway?"
    ),
    # Green — Community / Empathy
    16: ("When was the last time you truly listened to someone without planning your response?"),
    17: ("Reflect on a time you changed your mind because of empathy. How did that feel?"),
    18: ("What community needs are you aware of but not acting on? What holds you back?"),
    # Yellow — Integration / Systems
    19: ("How do the different parts of your life connect? Where do you see patterns repeating?"),
    20: ("Describe a belief you once held strongly but have since released. What replaced it?"),
    21: (
        "If you could redesign one system in your life "
        "(routine, relationship, work), what would you change and why?"
    ),
    # Turquoise — Holistic / Global
    22: ("How does your personal growth connect to the wellbeing of those around you?"),
    23: ("Reflect on a moment of awe or wonder you experienced recently. What did it reveal?"),
    24: "What legacy are you building, whether you intend to or not?",
    # Coral — Transcendence / Purpose
    25: (
        "What feels like your deepest purpose right now? "
        "How has it evolved since you started this program?"
    ),
    26: ("Describe a moment when you felt aligned with something beyond yourself."),
    27: "What are you willing to sacrifice for what matters most to you?",
    # Teal — Adaptive / Flow
    28: "When do you experience flow? What conditions make it possible?",
    29: (
        "Reflect on a recent change that felt uncomfortable. "
        "What did you learn from adapting to it?"
    ),
    30: "How do you balance structure and spontaneity in your daily life?",
    # Indigo — Depth / Contemplation
    31: ("What question have you been avoiding? Sit with it now and write whatever comes."),
    32: ("Describe your inner landscape today. What textures, colors, or feelings do you notice?"),
    33: "What has silence taught you during this program?",
    # Ultraviolet — Mastery / Contribution
    34: ("What wisdom have you gained that you wish you could give to your past self?"),
    35: (
        "How will you continue the practices you have built here? "
        "What needs to change for them to endure?"
    ),
    36: ("Write a letter to the person you are becoming. What do you want them to remember?"),
}

TOTAL_WEEKS = 36


def get_prompt_for_week(week_number: int) -> str | None:
    """Return the prompt question for a given week, or None if out of range."""
    return WEEKLY_PROMPTS.get(week_number)

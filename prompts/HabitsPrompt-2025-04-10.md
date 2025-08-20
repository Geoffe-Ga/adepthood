We are building the APTITUDE Webapp.

Your output should be clean, dry, well-formatted, functional, running,
production-ready code in a single Canvas. Be sure NOT to supply code in either
Snippets or in plain text. I can install any packages needed and I would like
to run the code that you provide exactly as it is provided.

The final result should be a beautiful website that is mobile and desktop
friendly and that adheres to a style that mixes modern minimalism with a touch
of the mystical.

I will attach the Habits.tsx file to this chat (which was made by OpenAI and
Claude... I think you can do better!) so you can make the necessary changes.
This is a list of what I don't like about the current interface:

- The colors are overpowering. Instead of using the colors as the background
  for each Habit, use them as the progress bars. Make the background of each
  habit something more inoffensive and visually appealing.
- Make the progress bars thicker by double
- For "addititve" habits, include markers for Low Grit and Clear goals along
  the progress bar. Then, when the Clear goal is met, start the progress bar
  over in a new color with the Clear goal on the left and the remaining units
  to the Stretch goal across to the right.
- Add interstitial lines on each progress bar that show how many units are left
  to complete it. Add logic to simplify the interstitial lines if there are too
  many of them (for example, if we have to log 45 mintues of meditation for a
  Clear Goal, 30 for a Low Grit Goal and 60 for a Stretch Goal, just show 15
  minute increments)
- the Edit Goals button doesn't do anything.
- You should be able to edit the target, the target_unit, the frequency and the
  frequency unit separately wherever they appear. target validates for numbers,
  target_unit allows selection from a dropdown, frequency validates for
  numbers, and frequency_unit also allows selection from a drop down.
- There is no way to add a specific frequency of [Mon, Tue, Wed,]
- The overpowering color issue applies to the Goal Modals as well. As does the
  change request regarding color and thickness of the lines.
- The Longest Streak, Current Streak, Completion Rate and Total Completions
  field headers are too far away from their values in the Stats screens. Let's
  center those instead, with the headers right-aligned and the stats
  left-aligned at the center of the screen.
- In the Edit Habit modal, the Developmental Stage selector should be replaced
  by a Re-Order button that creates a new modal in which you can drag the
  habits up and down on a list that has Beige at the top and Clear Light at the
  bottom, with their projected start dates along the side (the start dates stay
  where they are and the Habits can be dragged to in front of / behind one
  another moving the whole list so that each Habit aligns with a start date)
- I can't tell what aligns to what on the Edit Habit screen. Let's make the
  headers right aligned and the properties left aligned at the center of the
  screen like we did for the Stats screen.
- In Energy Rating, please include an un-editable column for Net Energy
- In the Cost and Return columns, please validate that the number is between
  -10 and 10
- Turning Reminder Notifications on/off should be a slider and then a more
  detailed picker should pop up saying "time of day" with a scrollable wheel to
  select the time, then a + button to add another time.
- Let's make the whole Edit Habit Modal narrower. Make sure the padding is
  equal between all items within it. Make sure the font sizes are consistent.
- Make the Icons selector a searchable inventory of all Emojis.
- When depressing the mouse or tapping on a Habit, the box that it lives in
  should shrink, the same way it does for double clicking. While holding down,
  surface a tool tip that says "Hold to edit, Double-Tap to Log"
- The habits currently displayed are the defaults. Grey all of them out as an
  indication that they are optional until their associated Stages are
  unlocked (except for Beige) but make sure they are still editable and their
  goals can be examined and logged.
- Add a "Perform Energy Scaffolding" button at the bottom that launches the
  Onboarding flow.

## Product spec

The following describes the Energy Scaffolding process as well as the
requirements for the Habits screen, for which a Work in Progress `.tsx` file is
attached to this chat as `Habits.txt`

### Summary

Create a web application called **Adepthood** that guides users through the **
APTITUDE** program. This program, known as ***Adepthood: Praxis and Theory for
Integrating, Transcending and Unbridling from Determinism Effectively,*** helps
users develop **Free Will and Self-Actualization**. It celebrates and
integrates the 'Growing Up' stages from Integral Theory, combined with an
original model called **The Archetypal Wavelength**, which addresses
oscillations between poles like Mania/Depression or Attraction/Aversion. The
goal is to help users progress from suffering and unskillful cravings,
reactivity and karma towards greater **Wholeness and Equanimity**.

The Adepthood app consists of four main screens: **Journal**, **Course**, **
Habits**, and **Map**. Each screen should have a distinct purpose and
aesthetic, but remain cohesive under a mystical, yet user-friendly interface.

### Habits screen

Create a React Native application that clones much of the functionality of the
iOS "Streaks" app. The app should allow users to track habits, set goals, and
log their progress daily. Include the following features:

1. **Home Screen**:

- Display a grid of user-defined streaks ("Habits") with progress indicators.
- If more than 10 Habits are created, include pagination via swiping
- Show the icon for each Habit, the current streak count for that Habit, and
  completion status for the day.
- Allow users to double tap on a Habit to mark it as complete for the day.
- Allow users to long press on a Habit to edit it.
- The icons for 10 Habits should fit on the screen once onboarding is done
- During onboarding, after showing all ten habits on the screen for a moment,
  the user taps again and whichever habits start dates (defined in 21 day
  increments earlier) have not yet arisen do not get displayed.

2. **Habit Stats**:

- Show a detailed history of each streak, including a calendar view with marked
  completion days.
- Display statistics like longest streak, current streak, and overall
  completion rate.
- Display line graphs showing cumulative progress
- Display bar graphs showing habit completion by "day of week"

3. **Notifications**:

- Implement push notifications to remind users to complete their streaks.
- Make notification frequency customizable per streak.

4. **Missed Days Recovery**:

- If the user doesn't log in for a few days, prompt them with, 'Missed you! Did
  you keep it up while you were gone?' Include options for 'Yes!' (backfill the
  missed days) or 'New start date' (open a calendar picker).

5. **Milestones and Encouragement**:

- Notify users with milestones like 'You've been going for 10 days!' and allow
  them to toggle notifications for such events.

6. **UI/UX Design**:

- Use a modern, clean, and user-friendly design.
- Optimize for responsiveness on both iOS and Android devices, as well ask
  desktop browser interfaces.

7. **Local Storage & Cloud Sync**:

- Use local storage for offline functionality.
- Include Firebase or another cloud backend for optional account-based sync.

8. **Onboarding**:

- **The process for creating new Habits works like this:**
    1. The user enters in all the habits they'd like to create or destroy
    2. They assign a numerical value (-10 to 10) to how much of an energy
       investment each habit is
    3. They assign a numerical value (-10 to 10) to how much energy they'll get
       back from doing the habit regularly
    4. They hit "Go!" and the app orders those habits from highest net energy
       returned, with ties broken by lowest energy investment first and most
       energy returned second
    5. This displays a list of habits and dates, where the dates begin on an
       editable start date (calendar pop up) and then increase by 21 days for
       each subsequent habit down the list.
    6. They are given the opportunity to drag things around if their habit
       order isn't perfect for what they prefer
    7. They select icons for each habit and describe their goals for them,
       including a "Low Grit" goal, a "Clear Goal" and a "Stretch Goal", which
       are each times per day and days per week

## Tech Stack

- **Frontend**: React Native + Expo
- **Backend**: FastAPI + PostgreSQL
- **ORM**: SQLAlchemy + Pydantic
- **AI Assistant**: OpenAI or Local LLM
- **Hosting**: Undecided
- **CMS**: Squarespace

## Data model

Make sure that the code you provide adheres to the `data_model` as provided
below:

```
from sqlmodel import SQLModel, Field, Relationship
from typing import Optional, List
from datetime import date, datetime

class User(SQLModel, table=True):
    """
    Represents a user account. Tracks relationships to habits, journal entries,
    weekly responses, and APTITUDE stage progress. Also includes offering_balance
    for credit-based access to AI features.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    offering_balance: int = Field(default=0)    email: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    habits: List["Habit"] = Relationship(back_populates="user")
    journals: List["JournalEntry"] = Relationship(back_populates="user")
    responses: List["PromptResponse"] = Relationship(back_populates="user")
    stage_progress: Optional["StageProgress"] = Relationship(back_populates="user")

class Habit(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    icon: str
    start_date: date
    energy_cost: int
    energy_return: int
    user_id: int = Field(foreign_key="user.id")
    user: User = Relationship(back_populates="habits")
    goals: List["Goal"] = Relationship(back_populates="habit")

class Goal(SQLModel, table=True):
    """
    Represents a single target for a habit, defined by a measurable unit (target_unit)
    and frequency (frequency_unit). Goals can be additive (e.g. drink 8 cups of water)
    or subtractive (e.g. limit caffeine to 200mg).

    Use is_additive = True for goals where success is defined by reaching or exceeding the target.
    Use is_additive = False for goals where success is defined by staying under the target.

    When multiple goals share the same target_unit and are part of a tiered system (e.g. low, clear, stretch),
    they should be grouped using goal_group_id. This allows the system to evaluate all tiers together based
    on the same logged completions.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    habit_id: int = Field(foreign_key="habit.id")
    title: str
    description: Optional[str] = None
    tier: str  # "low", "clear", "stretch"
    target: float
    target_unit: str  # "minutes", "reps", etc.
    frequency: float  # e.g. 2.0 = 2x per frequency_unit
    frequency_unit: str  # "per_day", "per_week"
    days_of_week: Optional[List[str]] = Field(default=None, sa_column_kwargs={"type_": "text[]"})
    track_with_timer: bool = False
    timer_duration_minutes: Optional[int] = None
    origin: Optional[str] = None
    goal_group_id: Optional[int] = Field(default=None, foreign_key="goalgroup.id")
    goal_group: Optional["GoalGroup"] = Relationship(back_populates="goals")
    is_additive: bool = True
    habit: Habit = Relationship(back_populates="goals")
    completions: List["GoalCompletion"] = Relationship(back_populates="goal")

class GoalGroup(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    icon: Optional[str] = None
    description: Optional[str] = None
    user_id: Optional[int] = Field(default=None, foreign_key="user.id")
    shared_template: bool = False
    source: Optional[str] = None
    goals: List["Goal"] = Relationship(back_populates="goal_group")


class GoalCompletion(SQLModel, table=True):
    """
    A log of one instance of a user's engagement with a goal. Each log records
    the number of completed units and whether it was tracked via timer.

    For additive goals, all logs in a day are summed, and the day is successful if total >= target.
    For subtractive goals, all logs in a day are summed, and the day is successful if total < target.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    goal_id: int = Field(foreign_key="goal.id")
    user_id: int = Field(foreign_key="user.id")
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    completed_units: float
    via_timer: bool = False
    goal: Goal = Relationship(back_populates="completions")

class Practice(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    stage_number: int
    name: str
    description: str
    instructions: str
    default_duration_minutes: int
    submitted_by_user_id: Optional[int] = Field(default=None, foreign_key="user.id")
    approved: bool = True

class UserPractice(SQLModel, table=True):
    """
    Connects a user to a selected Practice for a given stage. Tracks the time window
    of engagement with the practice.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id")
    practice_id: int = Field(foreign_key="practice.id")
    stage_number: int
    start_date: date
    end_date: Optional[date] = None

class PracticeSession(SQLModel, table=True):
    """
    A single session log for a Practice the user is engaged with. Tracks duration
    and timestamp, allowing later evaluation of consistency.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    user_practice_id: int = Field(foreign_key="userpractice.id")
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    duration_minutes: float

class JournalEntry(SQLModel, table=True):
    """
    Stores a chat message between the user and BotMason. Supports context tagging
    for stage reflections, practice notes, and habit-related thoughts.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    message: str
    sender: str  # 'user' or 'bot'
    user_id: int = Field(foreign_key="user.id")
    is_stage_reflection: bool = False
    is_practice_note: bool = False
    is_habit_note: bool = False
    practice_session_id: Optional[int] = Field(default=None, foreign_key="practicesession.id")
    user_practice_id: Optional[int] = Field(default=None, foreign_key="userpractice.id")
    user: User = Relationship(back_populates="journals")

class PromptResponse(SQLModel, table=True):
    """
    Captures responses to weekly prompts within the APTITUDE program.
    Used for tracking journaling engagement.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    week_number: int
    question: str
    response: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    user_id: int = Field(foreign_key="user.id")
    user: User = Relationship(back_populates="responses")

class StageProgress(SQLModel, table=True):
    """
    Tracks which stage a user is currently working on, and which stages
    have been completed.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    current_stage: int
    completed_stages: List[int] = Field(sa_column_kwargs={"type_": "integer[]"})
    user_id: int = Field(foreign_key="user.id", unique=True)
    user: User = Relationship(back_populates="stage_progress")

class StageContent(SQLModel, table=True):
    """
    Represents individual content entries (essays, prompts, etc.) tied to a course stage.
    Each item can be scheduled based on the number of days since the user began the stage.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    course_stage_id: int = Field(foreign_key="coursestage.id")
    title: str
    content_type: str  # e.g., "essay", "prompt", "video"
    release_day: int
    url: str


class CourseStage(SQLModel, table=True):
    """
    Represents a single educational stage in the APTITUDE course.
    Includes metadata used for organizing curriculum content, contextually
    relevant theory (e.g., Spiral Dynamics color, developmental stage, etc.),
    and aesthetic display.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    title: str
    subtitle: str
    stage_number: int
    overview_url: str
    category: str
    aspect: str
    spiral_dynamics_color: str
    growing_up_stage: str
    divine_gender_polarity: str
    relationship_to_free_will: str
    free_will_description: str
```
from __future__ import annotations

from datetime import date, datetime

from sqlmodel import Field, Relationship, SQLModel


class User(SQLModel, table=True):
    """
    Represents a user account. Tracks relationships to habits, journal entries,
    weekly responses, and APTITUDE stage progress. Also includes offering_balance
    for credit-based access to AI features.
    """

    id: int | None = Field(default=None, primary_key=True)
    offering_balance: int = Field(default=0)
    email: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    habits: list[Habit] = Relationship(back_populates="user")
    journals: list[JournalEntry] = Relationship(back_populates="user")
    responses: list[PromptResponse] = Relationship(back_populates="user")
    stage_progress: StageProgress | None = Relationship(back_populates="user")


class Habit(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    icon: str
    start_date: date
    energy_cost: int
    energy_return: int
    user_id: int = Field(foreign_key="user.id")
    user: User = Relationship(back_populates="habits")
    goals: list[Goal] = Relationship(back_populates="habit")


class Goal(SQLModel, table=True):
    """
    Represents a single target for a habit, defined by a measurable unit
    (target_unit) and frequency (frequency_unit). Goals can be additive
    (e.g. drink 8 cups of water) or subtractive (e.g. limit caffeine to 200mg).

    Use is_additive = True for goals where success is defined by reaching or
    exceeding the target. Use is_additive = False for goals where success is
    defined by staying under the target.

    When multiple goals share the same target_unit and are part of a tiered
    system (e.g. low, clear, stretch), they should be grouped using
    goal_group_id. This allows the system to evaluate all tiers together based on
    the same logged completions.
    """

    id: int | None = Field(default=None, primary_key=True)
    habit_id: int = Field(foreign_key="habit.id")
    title: str
    description: str | None = None
    tier: str  # "low", "clear", "stretch"
    target: float
    target_unit: str  # "minutes", "reps", etc.
    frequency: float  # e.g. 2.0 = 2x per frequency_unit
    frequency_unit: str  # "per_day", "per_week"
    days_of_week: list[str] | None = Field(default=None, sa_column_kwargs={"type_": "text[]"})
    track_with_timer: bool = False
    timer_duration_minutes: int | None = None
    origin: str | None = None
    goal_group_id: int | None = Field(default=None, foreign_key="goalgroup.id")
    goal_group: GoalGroup | None = Relationship(back_populates="goals")
    is_additive: bool = True
    habit: Habit = Relationship(back_populates="goals")
    completions: list[GoalCompletion] = Relationship(back_populates="goal")


class GoalGroup(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    icon: str | None = None
    description: str | None = None
    user_id: int | None = Field(default=None, foreign_key="user.id")
    shared_template: bool = False
    source: str | None = None
    goals: list[Goal] = Relationship(back_populates="goal_group")


class GoalCompletion(SQLModel, table=True):
    """
    A log of one instance of a user's engagement with a goal. Each log records
    the number of completed units and whether it was tracked via timer.

    For additive goals, all logs in a day are summed, and the day is
    successful if total >= target.
    For subtractive goals, all logs in a day are summed, and the day is
    successful if total < target.
    """

    id: int | None = Field(default=None, primary_key=True)
    goal_id: int = Field(foreign_key="goal.id")
    user_id: int = Field(foreign_key="user.id")
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    completed_units: float
    via_timer: bool = False
    goal: Goal = Relationship(back_populates="completions")


class Practice(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    stage_number: int
    name: str
    description: str
    instructions: str
    default_duration_minutes: int
    submitted_by_user_id: int | None = Field(default=None, foreign_key="user.id")
    approved: bool = True


class UserPractice(SQLModel, table=True):
    """
    Connects a user to a selected Practice for a given stage. Tracks the time window
    of engagement with the practice.
    """

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id")
    practice_id: int = Field(foreign_key="practice.id")
    stage_number: int
    start_date: date
    end_date: date | None = None


class PracticeSession(SQLModel, table=True):
    """
    A single session log for a Practice the user is engaged with. Tracks duration
    and timestamp, allowing later evaluation of consistency.
    """

    id: int | None = Field(default=None, primary_key=True)
    user_practice_id: int = Field(foreign_key="userpractice.id")
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    duration_minutes: float


class JournalEntry(SQLModel, table=True):
    """
    Stores a chat message between the user and BotMason. Supports context tagging
    for stage reflections, practice notes, and habit-related thoughts.
    """

    id: int | None = Field(default=None, primary_key=True)
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    message: str
    sender: str  # 'user' or 'bot'
    user_id: int = Field(foreign_key="user.id")
    is_stage_reflection: bool = False
    is_practice_note: bool = False
    is_habit_note: bool = False
    practice_session_id: int | None = Field(default=None, foreign_key="practicesession.id")
    user_practice_id: int | None = Field(default=None, foreign_key="userpractice.id")
    user: User = Relationship(back_populates="journals")


class PromptResponse(SQLModel, table=True):
    """
    Captures responses to weekly prompts within the APTITUDE program.
    Used for tracking journaling engagement.
    """

    id: int | None = Field(default=None, primary_key=True)
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

    id: int | None = Field(default=None, primary_key=True)
    current_stage: int
    completed_stages: list[int] = Field(sa_column_kwargs={"type_": "integer[]"})
    user_id: int = Field(foreign_key="user.id", unique=True)
    user: User = Relationship(back_populates="stage_progress")


class StageContent(SQLModel, table=True):
    """
    Represents individual content entries (essays, prompts, etc.) tied to a course stage.
    Each item can be scheduled based on the number of days since the user began the stage.
    """

    id: int | None = Field(default=None, primary_key=True)
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

    id: int | None = Field(default=None, primary_key=True)
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

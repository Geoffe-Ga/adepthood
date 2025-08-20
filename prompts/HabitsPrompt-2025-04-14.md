### We are building the APTITUDE Webapp.

Your output should be clean, dry, well-formatted, functional, running,
production-ready code in a single Artifact. Be sure NOT to supply code in
either
Snippets or in plain text. I can install any packages needed and I would like
to run the code that you provide exactly as it is provided.

The final result should be a beautiful website that is mobile and desktop
friendly and that adheres to a style that mixes modern minimalism with a touch
of the mystical.

I will attach the HabitTiles.tsx and HabitsScreen.tsx files to this chat (which
was made by OpenAI...
I think you can do better!) so you can make the necessary critiques and
changes. I will also
attach the Habits.styles.ts so you can see what styles we are working with,
although I would prefer not to change that file in this prompt response.

### This is a list of what I don't like about the current interface:

- I don't like the deep purple color for victory, please enable them to glow a
  golden color instead while remaining the same Stage Color. This is called a "
  victory color".
- The Goal progress isn't working right.
    - Additive Goals:
        - The lines that are meant to show units on the progress bar are
          impossible to see
        - It needs to be more clear what is happening when the Clear Goal is
          met and the bar resets for a Stretch Goal. Eg. Add the victory color
          and flash an alert that says "Achieved! Keep going for the Stretch
          Goal!"
        - When the Clear goal is met, the bar should start off 1/3rd full to
          represent the distance between Clear and Stretch targets.
    - Subtractive Goals:
        - When a goal isn't additive, ie when completing it involves abstaining
          from an unwanted habit you are trying to break, the progress bar
          should start completely full
        - Subtractive goals should display all three goal markers, Low, Clear
          and Stretch.
        - Generally the Stretch goal in a Subtractive goal will correspond to
          the fewest target units
        - The bar should start off completely full in the color of Victory (
          which you would normally only hit after completing the Clear goal and
          moving on to the Stretch Goal in an Additive goal)
        - As soon as the stretch goal is broken for a subtractive goal, the bar
          becomes its stage's color again
        -
- All tiles:
    - In addition to the stats icon in the upper right, there should be a
      pencil icon (to Edit habits) and a checkbox icon (to mark goal
      completions). This will replace the long press and double click as they
      exist now.
        - On mobile, instead of the three icons, each goal should have a `...`
          menu from which those three options can be accessed
    - The low, clear and stretch markers on the progress bar should be more
      pronounced and should be labelled for clarity with a tool tip that shows
      up on hover on a web interface and on a short press on mobile.
    - The interstitial markers should be visible even for already completed
      bars.
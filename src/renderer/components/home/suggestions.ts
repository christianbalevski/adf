/**
 * Sample first messages for the home composer. Each describes something an
 * agent keeps doing, not a question with one answer: what the chips offer is
 * what a new user learns an agent is. Edit freely; nothing else depends on
 * the wording. `pickSuggestions` draws a few at random per visit.
 */
export const SUGGESTION_POOL: readonly string[] = [
  // Files and folders
  'Watch my Downloads folder and tell me what lands there',
  'Keep my Desktop tidy: sort screenshots and downloads into folders by month',
  'Read a folder I point you at and keep notes on how it works',
  'Find duplicate files in a folder I give you and list them before deleting anything',
  'Rename the photos in a folder by the date they were taken',
  'Keep a running index of every PDF in my Documents folder with a one-line summary each',
  'Watch a project folder and tell me when a file changes that I said I care about',
  'Turn the receipts I drop in a folder into one spreadsheet',
  'Convert any audio file I drop in a folder into a transcript next to it',
  'Back up a folder I name to a second location every night and tell me if it fails',

  // Email
  'Draft replies to the email I forward you',
  'Read the newsletters I forward you and send me the three things worth knowing',
  'Sort the email I forward you into needs a reply, needs a decision, and can wait',
  'Turn the confirmation emails I forward you into a list of upcoming bookings',
  'Write a polite decline for every invitation I forward you unless I say otherwise',
  'Track the receipts and invoices I forward you and total them by month',
  'Chase the people I am waiting on: remind me who has not replied after three days',

  // Calendar and time
  'Check in every morning with what needs my attention',
  'Every Sunday evening, lay out my week from the notes I give you',
  'Remind me an hour before anything I tell you about, with what I need to bring',
  'Give me a short review of my day each evening and ask what carries over',
  'Keep a list of birthdays I give you and nudge me a week ahead',
  'Track my habits: ask me each night what I did and show me the streaks',
  'Plan my week around three priorities I give you Monday morning',

  // Research and reading
  'Follow a topic and send me a summary every week',
  'Watch a few websites I name and tell me when something on them changes',
  'Read the articles I send you and keep a note of the claims with their sources',
  'Compare the options I am weighing and keep the comparison updated as I learn more',
  'Read a long document I give you and answer my questions about it',
  'Build a reading list on a subject and keep track of what I have finished',
  'Every morning, check the sources I name for news about my industry',
  'Keep a glossary of terms I run into and explain each one in plain words',
  'Collect quotes and passages I send you, tagged by theme',
  'Fact-check the claims in a piece of writing I hand you and show your sources',

  // Writing
  'Help me keep a daily journal: ask me a question each evening and file my answer',
  'Edit what I paste for clarity without changing what it says',
  'Turn my rough notes into a clean memo and keep the memo as I add to it',
  'Keep the style of my writing consistent across everything I paste you',
  'Draft a weekly update from the notes I drop during the week',
  'Help me write a book: hold the outline and the chapters, and track what is done',
  'Turn a meeting transcript into decisions, owners, and next steps',
  'Keep a list of writing ideas I send you and pull one when I ask',
  'Write first drafts of the posts I outline, in my voice from samples I give you',
  'Proofread anything I paste and tell me what you changed',

  // Code and projects
  'Watch a repository I point you at and summarize each day\'s commits',
  'Read a codebase and keep an architecture note that stays current',
  'Review the diffs I paste and point out risks before I ship them',
  'Keep a changelog from the commit messages I give you',
  'Track the bugs I report to you and remind me of the open ones',
  'Explain the error messages I paste and suggest what to try next',
  'Turn my TODO comments in a folder into a task list that stays in sync',
  'Write tests for the functions I paste and tell me what they do not cover',
  'Keep a runbook for a project and update it whenever I tell you something changed',
  'Watch the logs I point you at and tell me when something new goes wrong',

  // Money
  'Track my spending from the statements I give you and show me the month by category',
  'Keep a budget I set and tell me when I am close to a limit',
  'Log the invoices I send and remind me which ones are unpaid',
  'Track subscriptions I tell you about and warn me before each renewal',
  'Keep a list of what I have lent and borrowed, and who owes what',
  'Turn my freelance hours into a monthly invoice from the notes I give you',
  'Compare prices for something I want to buy and tell me when it drops',

  // Health and home
  'Log my workouts from what I tell you and plan the next one',
  'Plan meals for the week from what is in my fridge and write the shopping list',
  'Keep a list of home repairs and remind me of the seasonal ones',
  'Track my sleep from the notes I send and show me the pattern',
  'Help me learn a recipe: walk me through it step by step when I ask',
  'Keep a medication schedule and check in that I took each dose',
  'Plan a garden for my space and remind me what to do each week',
  'Keep an inventory of the pantry from receipts and tell me what is running low',

  // Learning
  'Teach me a language ten minutes a day and keep track of what I know',
  'Quiz me on material I give you until I get it right',
  'Keep a study plan for an exam and adjust it as I report progress',
  'Explain one concept from a field I name every day, building on the last',
  'Keep flashcards from anything I ask you to remember and run me through them',
  'Track the courses and books I am working through and what is left',
  'Practice interviews with me for a role I describe and note where I stumble',

  // People and communication
  'Keep notes on the people I meet and remind me of details before I see them again',
  'Draft thank-you notes from the details I give you',
  'Keep track of promises I make to people and remind me to follow through',
  'Help me prepare for a difficult conversation and remember what we decided',
  'Turn my rambling voice notes into clear messages I can send',
  'Keep a list of gift ideas for the people I mention',

  // Work and operations
  'Run my standup: collect what I did, what is next, and what is blocked',
  'Keep the project plan and tell me when a date slips',
  'Triage the requests I paste into urgent, this week, and later',
  'Keep minutes for the meetings I describe and send me the actions',
  'Draft job descriptions from the role notes I give you',
  'Keep a decision log: what we chose, why, and what we ruled out',
  'Track vendor quotes and remind me when one expires',
  'Keep a list of open questions for a project and chase answers with me',
  'Prepare a weekly report for my manager from what I tell you during the week',
  'Keep our team glossary and onboarding notes up to date as I send changes',

  // Personal projects
  'Help me plan a trip: hold the itinerary, bookings, and the packing list',
  'Keep a list of places I want to visit with notes on why',
  'Plan a party: guests, food, and a timeline for the day',
  'Track a hobby project and keep a build log with photos I send',
  'Help me declutter one room at a time and keep the donate and sell lists',
  'Keep a wish list of things I want and check for deals when I ask',
  'Plan a move: what to cancel, what to set up, and when',
  'Keep a family calendar from the events each person tells you about',
  'Help me pick a name for something and keep the shortlist',
  'Plan and track a long-term goal: break it into months and check in on each',
]

/** `count` distinct entries from the pool, in random order. */
export function pickSuggestions(count: number, random: () => number = Math.random): string[] {
  const pool = [...SUGGESTION_POOL]
  const out: string[] = []
  while (out.length < count && pool.length > 0) {
    const i = Math.min(pool.length - 1, Math.floor(random() * pool.length))
    out.push(pool.splice(i, 1)[0])
  }
  return out
}

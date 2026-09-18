/**
 * Sample first messages for the home composer. Each describes something an
 * agent keeps doing, not a question with one answer: what the chips offer is
 * what a new user learns an agent is. About a quarter are the agent as the
 * person's own algorithm (their rules deciding what reaches them), and at
 * least a sixth have the agent build a page, dashboard, app or game as the
 * face it shows its principal. Edit freely; nothing else depends on the
 * wording. `pickSuggestions` draws a few at random per visit.
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
  'Read the newsletters I forward you and keep only the parts that match my current projects',
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
  'Follow a topic and send me a weekly summary shaped by what I said I want from it',
  'Watch a few websites I name and tell me when something on them changes',
  'Read the articles I send you and keep a note of the claims with their sources',
  'Compare the options I am weighing and keep the comparison updated as I learn more',
  'Read a long document I give you and answer my questions about it',
  'Build my reading queue by my priorities, not by what is newest, and let me reorder it',
  'Every morning, check the sources I name and bring me only the industry news that fits my rules',
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
  'Keep a wish list of things I want and sift the sales I subscribe to for only those',
  'Plan a move: what to cancel, what to set up, and when',
  'Keep a family calendar from the events each person tells you about',
  'Help me pick a name for something and keep the shortlist',
  'Plan and track a long-term goal: break it into months and check in on each',

  // Your own algorithm: the agent applies the person's rules to what reaches them
  'Be my feed: read the sources I name and show me only what fits the goals I gave you',
  'Curate a daily newsletter for me from the sites and feeds I choose, ranked by what I said I care about',
  'Build me a watch list of videos worth my time on a subject I am learning, and skip the ones that repeat',
  'Filter the news by my rules: no outrage bait, no rumors, one story per event',
  'Learn what I actually finish reading and use that to rank what you show me next',
  'Keep my interest profile as a file I can read and edit, and use it to filter everything you bring me',
  'Scan the podcasts I follow and tell me which episodes are worth it, given what I said I want to learn',
  'Pick three things worth my attention each morning from the sources I trust, and say why each made the cut',
  'Mute topics I tell you I am done with, and unmute them when I say so',
  'Show me the other side of the stories I read, from sources I have said I respect',
  'Track what I have already seen so nothing you recommend is a repeat',
  'Rank job postings from the boards I name against what I said matters to me',
  'Curate new music each week from the taste notes I give you, not from the charts',
  'Pull the papers from the journals I follow that fit my research questions, and skip the rest',
  'Keep a weekly digest of the forums I read with only the threads that match my interests',
  'Read the changelogs of the tools I use and tell me only about changes that affect how I work',
  'Rank the books people recommend to me by how well they fit what I want to read next',
  'Filter the social feeds I export to you by my own rules, and show me what got through and what did not',
  'When I say less of this, remember it and apply it to everything you show me from then on',
  'Score everything you bring me against my goals, and show the score so I can correct you',
  'Curate a weekly list of events near me that fit my interests and my calendar',
  'Watch the creators I follow and tell me only when they post in the areas I care about',
  'Learn from what I skip and what I save, and explain how that changed your picks',
  'Turn the sources I trust into one feed I control, with the rules written down where I can change them',
  'Pick a course or tutorial for each thing I say I want to learn, from what I already have access to',
  'Keep the ads and sponsored posts out of anything you show me, and tell me what you dropped',
  'Bring me the long reads worth a weekend, chosen by the questions I am chewing on',
  'Hold my rules for what counts as important, and ask me before you change them',
  'Decide what gets to interrupt me: only messages that match my rules come through now, the rest wait for the digest',
  'Keep a list of what I want less of and more of, and rebalance my feed each week',
  'Read the reviews for anything I am about to buy and weigh them the way I told you to, not by stars',
  'Shortlist apartments from the listings I follow using my must-haves and my deal-breakers',
  'Pick my next three shows from what is streaming, using what I loved and what I quit halfway',
  'Sort my inbox by my priorities, not by who shouts loudest',
  'Choose which of my notifications I actually see, from rules I set and can read',
  'Keep a taste file for restaurants and pick where we eat from what is nearby',

  // Pages, dashboards, apps and games: the face the agent builds for its principal
  'Build me a personal dashboard page: my goals, what is due, and what you found today',
  'Make a web page that shows my curated news, and let me thumbs-down anything to teach you',
  'Turn my reading list into a small website I can open on my phone',
  'Build a web page for our family with the calendar, the chores, and the shopping list',
  'Make a dashboard for my finances from the statements I give you',
  'Build a simple web app to log my habits and show the streaks',
  'Make a web page that tracks my job applications and their status',
  'Build a page that shows the status of my projects and what slipped',
  'Turn my recipes into a website with a search box and this week\'s meal plan',
  'Make a web game that quizzes me on the material I give you',
  'Build a small web game for my kids that practices the math they are working on',
  'Make a page where I can see every decision we made and why',
  'Build a web app for planning the trip: the map, the bookings, and the day-by-day plan',
  'Make a status page for my home servers and tell me when one drops',
  'Build a web page that shows my workout history and suggests the next session',
  'Make a dashboard of the repository: open issues, recent commits, and what needs review',
  'Build a page for my book with the outline, the chapters, and a progress bar',
  'Make a wall of the quotes I send you that I can flip through',
  'Build a web app where I can rate what you recommended so your picks get better',
  'Make a dashboard of my week: meetings, deadlines, and the three things that matter',
  'Build a page that compares the options I am weighing and updates as I learn more',
  'Make a small website for my side project with a changelog and a contact form that reaches you',
  'Build a countdown page for a goal, with the milestones we set along it',
  'Make a web page I can share with my team that shows the plan and who owns what',
  'Build a page of my curated feed that works offline on the train',
  'Make a tiny web app that shows one thing to do next, and nothing else',
  'Build a page that shows what you filtered out this week, so I can check your judgement',
  'Make a web app of my feed rules: toggles I flip that change what you send me',

  // Double takes: still a job, told straight
  'Watch my Downloads folder and tell me how many files are named final_v2',
  'Remind me to drink water, and escalate: polite, then concerned, then my mother',
  'Every Monday, list the things I said I would do next week, last week',
  'Read my calendar and tell me which meetings could have been an email, with evidence',
  'Chase the people I am waiting on, politely, then a little less politely each time',
  'Turn my rants into a calm two-sentence email I can actually send',
  'Total my subscriptions from receipts and tell me which ones I forgot I have',
  'Read the terms of service I paste you and find the one line I would actually be mad about',
  'Track the plants I forget to water and send the guilt trip from the plant\'s point of view',
  'Keep a list of the shows people recommend so I can keep not watching them',
  'Log the promises I make in messages and check whether I kept them',
  'Write my Friday status report from my commits and make it sound like I planned it',
  'Tell me when a website I watch changes, unless it is just the copyright year',
  'Keep a list of everyone who owes me money and exactly how many days they have owed it',
  'Sort my email into needs a reply, needs a decision, and why was I cc\'d',
  'Keep my Desktop tidy and tell me how many screenshots I will never look at again',
  'Watch the price of one thing I want and tell me when it drops, or when to stop waiting',
  'Read the newsletters I forward you and tell me which three sentences justified the whole thing',
  'Remind me of my own advice when I ask the same question twice',
  'Rank the recipes I say I will make by how long I have been saying it',
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

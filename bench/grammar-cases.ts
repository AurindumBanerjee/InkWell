/**
 * 50 hand-written sentences for the grammar evaluation: 40 with one or two planted errors (the
 * second field is the single correct fix) and 10 already correct (the answer must be unchanged).
 * Synthetic, written for this benchmark; no real user text.
 */
export interface GrammarCase {
  input: string;
  expected: string;
}

const fixes: Array<[string, string]> = [
  ['She dont like coffee in the morning.', "She doesn't like coffee in the morning."],
  ['The team have finished there report.', 'The team has finished their report.'],
  ['I seen the new design yesterday.', 'I saw the new design yesterday.'],
  ['Their going to ship the release on friday.', "They're going to ship the release on Friday."],
  ['Me and him wrote the parser.', 'He and I wrote the parser.'],
  ['The server crashed becuase of a memory leak.', 'The server crashed because of a memory leak.'],
  ['Each of the tests are independent.', 'Each of the tests is independent.'],
  ['We recieved the invoice last week.', 'We received the invoice last week.'],
  ['Its important to back up the database.', "It's important to back up the database."],
  ['He go to the office every day.', 'He goes to the office every day.'],
  ['The the editor supports offline mode.', 'The editor supports offline mode.'],
  ['There is many ways to merge changes.', 'There are many ways to merge changes.'],
  ['She has less bugs than before.', 'She has fewer bugs than before.'],
  ['The documents was shared with everyone.', 'The documents were shared with everyone.'],
  ['I would of fixed it sooner.', 'I would have fixed it sooner.'],
  ['Who\'s laptop is this?', 'Whose laptop is this?'],
  ['The cat chased it\'s tail.', 'The cat chased its tail.'],
  ['We was waiting for the build to finish.', 'We were waiting for the build to finish.'],
  ['This is a occasion to celebrate.', 'This is an occasion to celebrate.'],
  ['He runned the migration twice.', 'He ran the migration twice.'],
  ['The reviewer, who was tired approved the change.', 'The reviewer, who was tired, approved the change.'],
  ['Please send me the the latest numbers.', 'Please send me the latest numbers.'],
  ['They has not replied yet.', 'They have not replied yet.'],
  ['A lot of user report slow loading.', 'A lot of users report slow loading.'],
  ['I definately want to join the call.', 'I definitely want to join the call.'],
  ['The meeting is at 3pm tomorow.', 'The meeting is at 3pm tomorrow.'],
  ['Neither of the options are ideal.', 'Neither of the options is ideal.'],
  ['She said that she dont know.', "She said that she doesn't know."],
  ['Between you and I, the plan is risky.', 'Between you and me, the plan is risky.'],
  ['We need to seperate the two concerns.', 'We need to separate the two concerns.'],
  ['The data shows a clear trend, however it is noisy.', 'The data shows a clear trend; however, it is noisy.'],
  ['He is more taller than his brother.', 'He is taller than his brother.'],
  ['I am looking forward to meet you.', 'I am looking forward to meeting you.'],
  ['The function return a promise.', 'The function returns a promise.'],
  ['Everyone have to log in first.', 'Everyone has to log in first.'],
  ['Thanks for you help with the deploy.', 'Thanks for your help with the deploy.'],
  ['We adress the issue in the next sprint.', 'We address the issue in the next sprint.'],
  ['The lib is open source,and well documented.', 'The lib is open source, and well documented.'],
  ['Its been a long week for the whole team.', "It's been a long week for the whole team."],
  ['She enjoy reading about distributed systems.', 'She enjoys reading about distributed systems.'],
];

const clean: string[] = [
  'The editor merges concurrent changes without conflicts.',
  'Readers can leave comments anchored to a selection.',
  'Version history keeps every snapshot for ninety days.',
  'We measured a median latency of two milliseconds.',
  'Invite a teammate from the share dialog.',
  'The `sync` module batches updates before sending them.',
  'Search results are ranked by title first, then by body.',
  'Offline edits are stored locally and merged on reconnect.',
  'Owners can change roles; viewers can only read.',
  'See [the guide](https://example.com/guide) for details.',
];

export const GRAMMAR_CASES: GrammarCase[] = [
  ...fixes.map(([input, expected]) => ({ input, expected })),
  ...clean.map((s) => ({ input: s, expected: s })),
];

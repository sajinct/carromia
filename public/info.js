// Published event information and rules, as announced on the tournament poster.
// Entry fee, team slots, teams per parish and the registration deadline are event settings
// (Tournament desk → Event settings); everything else about the event is edited here.

export const prizes = [
  { place: '1st prize', amount: 10001 },
  { place: '2nd prize', amount: 5001 },
  { place: '3rd prize', amount: 3001 }
];

export const timeline = [
  ['09:00 AM', 'Check-in'],
  ['09:30 AM', 'Opening ceremony'],
  ['10:00 AM', 'Preliminary round'],
  ['01:30 PM', 'Lunch break'],
  ['02:30 PM', 'Quarter finals'],
  ['04:30 PM', 'Finals'],
  ['05:30 PM', 'Awards']
];

export const massTimes = ['7:00 AM', '9:00 AM'];

export const venueAddress = '24, Church Service Road, Sri Krishnadevaraya Rd, Hoshalli Extension, Stage 1, Vijayanagar, Bengaluru, Karnataka 560040';

export const about = 'For the first time in the history of Mandya Diocese, a diocese-wide carrom tournament is being hosted to bring our parishes together. Show your skills and represent your church in this historic tournament.';

// Bring these to the registration desk on the day.
export const documents = [
  'Letter from the Parish Priest (attested)',
  'Any Government ID proof (Aadhaar, driving licence, etc.)',
  'Parish family record book (digital diary or physical)'
];

export const goodToKnow = [
  'Reporting time is 9:00 AM.',
  'Water and snacks are provided for participants only.',
  'Lunch is available to participants who pre-book it in the online registration form.'
];

// Rules are numbered 1–16 across the sections, as on the poster.
export const ruleSections = [
  { title: 'General format & tournament structure', rules: [
    'All India Carrom Federation (AICF) standards.',
    'Thumbing game only.',
    'Only doubles (2 players) game.',
    'Best of three (3) games format (must win 2 games). Anticlockwise rotation of players after each game.',
    'Knockout basis only.'
  ] },
  { title: 'Time limit & match completion', rules: [
    'Players will be provided 30 minutes to complete 3 games (10 minutes each).',
    'Matches are to be completed within 30 minutes (3 games); otherwise the match will be decided on the least coins on the board (black or white). No points are considered. The red (Queen) is pocketed only to complete the game.'
  ] },
  { title: 'Striker, board & pieces', rules: [
    'Strikers will be provided by the organisers. Bringing or using outside strikers is strictly prohibited.',
    'The board and pieces: the board features 9 white pieces, 9 black pieces and 1 red Queen piece, set up in a precise, tight hexagon pattern at the centre.'
  ] },
  { title: 'The break', rules: [
    'Players flip a coin or guess a hidden piece to see who goes first. The first player aims to pocket the white pieces, or chooses a side to be seated, to begin the match.'
  ] },
  { title: 'Queen & winning the game', rules: [
    'The Queen: the red Queen can be pocketed at any time once you have started sinking your pieces, but it must be “covered” by pocketing one of your own carrom pieces on the very next shot.',
    'Winning the match: the first person or team to pocket all of their assigned carrom pieces, along with a covered Queen, wins the board or game.'
  ] },
  { title: 'Draw / tie & qualification', rules: [
    'If the match is a draw or a tie between the teams, each team will get 3 coins to pocket (Golden Pocket). The team that pockets the most will qualify for the next round.',
    'If the Golden Pocket (rule 13) is also a draw, the match goes to sudden death: the teams toss a coin for the first chance to pocket a coin, and the team that pockets first will qualify for the next round.'
  ] },
  { title: 'Umpire decision', rules: [
    'The umpire’s decision will be final (KSCA umpires only).'
  ] },
  { title: 'Player conduct', rules: [
    'Each player is to use their own idea; no prompting or suggestions from the partner are allowed while playing the game.'
  ] }
];

export const tieMethods = ['Golden Pocket', 'Sudden death'];

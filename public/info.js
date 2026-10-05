// Published event information and revised tournament rules.
// Entry fee, team slots, teams per parish and the registration deadline are event settings
// (Tournament desk → Event settings); everything else about the event is edited here.

export const prizes = [
  { place: '1st prize', amount: 15001 },
  { place: '2nd prize', amount: 10001 },
  { place: '3rd prize', amount: 5001 }
];

export const registrationContacts = [
  { name: 'Sajin CT', phone: '9605551004' },
  { name: 'Windoor Thomas', phone: '9845712799' },
  { name: 'Febin', phone: '8129966736' }
];

// Add the two remaining program coordinators here when their details are available.
export const programCoordinators = [
  { name: 'MC George', phone: '9620753153' }
];

// The original published support list used the same placeholder phone for all three people.
// Replace that legacy list without requiring a database update; later Settings edits still apply.
const legacyContactNames = ['Mr. K.J.Paul', 'Mr.Shaji Antony', 'Mr.K.J.Sebastian'];
export function supportContacts(event) {
  const contacts = event.contacts || [];
  const legacy = contacts.length === legacyContactNames.length && contacts.every((c, i) => c.name === legacyContactNames[i] && c.phone === '9605551004');
  return contacts.length && !legacy ? contacts : registrationContacts;
}

export const timeline = [
  ['09:45 AM', 'Participant reporting and check-in'],
  ['10:30 AM', 'Registration desk closes'],
  ['10:30 AM', 'Inauguration ceremony'],
  ['11:00 AM', 'Matches start'],
  ['01:30 PM', 'Lunch break'],
  ['02:30 PM', 'Quarter finals'],
  ['04:30 PM', 'Finals'],
  ['05:30 PM', 'Awards']
];

export const massTimes = ['8:30 AM'];
export const massVenue = 'Mary Matha Church, Vijayanagar';

export const venueAddress = '24, Church Service Road, Sri Krishnadevaraya Rd, Hoshalli Extension, Stage 1, Vijayanagar, Bengaluru, Karnataka 560040';
export const venueMapsUrl = 'https://www.google.com/maps/place/Mary+Matha+Church/@12.9670704,77.5450189,21z/data=!4m14!1m7!3m6!1s0x3bae3de229170451:0xe58df59f05578497!2sMary+Matha+Church!8m2!3d12.967178!4d77.5450341!16s%2Fg%2F1hc1qpsty!3m5!1s0x3bae3de229170451:0xe58df59f05578497!8m2!3d12.967178!4d77.5450341!16s%2Fg%2F1hc1qpsty?entry=ttu&g_ep=EgoyMDI2MDkzMC4wIKXMDSoASAFQAw%3D%3D';

export const about = 'For the first time in the history of the Diocese of Mandya, a diocese-wide carrom tournament is being hosted to bring our parishes together. Show your skills and represent your Parish in this historic tournament.';

// Bring these to the registration desk on the day.
export const documents = [
  'Your registration form (download it after registering), signed by both players and attested by the Parish Priest with the parish seal',
  'Any Government ID proof (Aadhaar, driving licence, etc.)',
  'Parish family record book (digital diary or physical)'
];

export const goodToKnow = [
  'Both players must report at 9:45 AM. The registration desk closes at 10:30 AM; late teams may forfeit their slot.',
  'The inauguration begins at 10:30 AM, followed by the announcement of fixtures. Matches begin at 11:00 AM.',
  'The entry fee includes water and refreshments for both registered players; these are provided to participants only.',
  'Lunch is included for participants who pre-book it during registration. Select zero, one or two lunches per team.',
  'Booked lunches have food coupons on the downloadable registration form. Present the coupons when collecting lunch.',
  'Both players must be present at their allotted board when their match is called; absence may result in a walkover.',
  'The tournament desk may refuse check-in if a player, their ID proof or the attested form does not match the registration.'
];

// Each timed round on the tournament app represents one board. Tie-breaks decide that board,
// and boards won decide the match; no carrom point scoring is used in this event.
export const ruleSections = [
  { title: 'General format & tournament structure', rules: [
    'The tournament follows the All India Carrom Federation (AICF) Laws of Carrom, except for the specific tournament modifications stated below.',
    'This is a thumbing-only tournament. All strokes must be played using the thumb.',
    'Each team consists of two registered players. Four players participate in each match, with partners seated opposite each other.',
    'Each match is the best of three boards. The first team to win two boards wins the match. Each timed round on the tournament app represents one board. Players move anticlockwise to the next right-hand seating position after each board.',
    'The tournament follows a knockout format. A third-place playoff will be held between the two teams that lose in the semifinals.'
  ] },
  { title: 'Time limit & match completion', rules: [
    'Each board has a maximum playing time of 10 minutes, giving a maximum of 30 minutes of regular playing time per match. Setup, seating changes, umpire-authorized stoppages and tie-breaks are additional to regular playing time. The third board is played only if required.',
    'At the end of 10 minutes, the umpire stops play after any stroke already taken has been completed and applicable penalties resolved. If the board is unfinished, the team with fewer assigned pieces remaining wins that board. The Queen is excluded from this count, and an uncovered Queen does not prevent a timeout win. Equal counts are resolved by Golden Pocket and, if required, sudden death. No point scoring is used; boards won determine the match winner.'
  ] },
  { title: 'Striker, board & pieces', rules: [
    'Organizers provide the strikers. Personal strikers are not permitted.',
    'Each board uses nine white pieces, nine black pieces and one red Queen. The pieces are arranged in the prescribed opening formation, with the Queen at the centre.'
  ] },
  { title: 'The break', rules: [
    'The umpire conducts the toss before each match. The winning team chooses either the opening break or its seating side; the other team receives the remaining choice. The team taking the break plays white for that board. The opening break alternates between teams on successive boards.'
  ] },
  { title: 'Queen & winning a board', rules: [
    'The Queen must be pocketed and covered in accordance with the applicable AICF rules. Covering may occur in the same stroke or the immediately following stroke, subject to the opening and eligibility provisions. An uncovered Queen is returned to the board by the umpire.',
    'Subject to applicable fouls and penalties, the team that legally pockets all nine of its assigned pieces first wins the board, provided the Queen has been properly pocketed and covered by either team. Pocketing the last assigned piece while the Queen remains on the board results in loss of the board.'
  ] },
  { title: 'Golden Pocket & sudden death', rules: [
    'If an unfinished board is tied at the time limit, each team receives three attempts to pocket three pieces, one attempt per piece. Corresponding attempts use identical piece and striker positions, prescribed by the umpires and announced before the tournament. Partners take alternate attempts. A foul counts as an unsuccessful attempt. After both teams complete their three attempts, the team with more successful pockets wins the board.',
    'If Golden Pocket remains tied, each team receives one attempt per sudden-death round from identical prescribed positions. A toss determines shooting order. Both teams must complete their attempt before a result is decided. A team wins the board when it pockets its piece and the other team misses or commits a foul. If both succeed or both fail, another round is played. Partners continue alternating attempts.'
  ] },
  { title: 'Umpires & decisions', rules: [
    'Matches are officiated by Karnataka State Carrom Association (KSCA) umpires. The umpire’s decision governs play. Any dispute must be referred promptly to the designated Chief Referee, whose decision is final.',
    'The umpire decides each board, including timeout and tie-break results, and an official marks the winning team for that round on the tournament app. The next board begins when the official starts the next round.'
  ] },
  { title: 'Player conduct & registered pairings', rules: [
    'Partners must not offer advice, prompt each other or communicate through gestures during a board. Violations are penalized by the umpire under the applicable rules.',
    'Registered pairings are fixed for all teams, including multiple teams from the same parish. Players may not be exchanged between teams. Any proposed substitution must receive organizer approval before the fixtures are finalized.'
  ] }
];

// The match format from Event settings: best of 3 rounds (games) of 10 minutes by default.
export const matchFormat = event => ({ rounds: event.gamesPerMatch ?? 3, minutes: event.gameMinutes ?? 10 });
export const formatText = event => { const { rounds, minutes } = matchFormat(event); return rounds === 1 ? `one round of ${minutes} minutes` : `the best of ${rounds} rounds, ${minutes} minutes each`; };

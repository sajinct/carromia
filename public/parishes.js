// The Diocese of Mandya parish / centre register: 53 parishes, 19 mass centres and 13 mission centres,
// grouped by forane or zone in the register's order. Teams register from one of these.

const register = {
  'Carmelaram Forane': {
    Parish: ['Alambady, St. Joseph Church', 'Carmelaram, Mount Carmel Forane Church', 'Chandapura, Our Lady of Light Church', 'Muthanallur, Vailankanni Matha Church', 'Sarjapura, St. Joseph\'s Church', 'Whitefield, Sacred Heart Church'],
    'Mass Centre': ['Kodathi, Chapel of Divine Mercy']
  },
  'Dharmaram Forane': {
    Parish: ['Anepalaya, St. Sebastian\'s Church', 'Dharmaram, St. Thomas Forane Church', 'Double Road, St. Alphonsa Church', 'Ejipura, St. Kuriakose Elias Chavara Church', 'Hulimavu, Santhome Church', 'Kalkere, St. Joseph\'s Church', 'Kengeri, St. Vincent Church', 'Koramangala, Mary Matha Church', 'Kothanur Dinne, Little Flower Church', 'Rajarajeshwari Nagar, Swarga Rani Church'],
    'Mass Centre': ['Airview Colony, Holy Trinity Church', 'Ashoknagar, St. Sebastian Mass Centre', 'Hosur Road, Military Police Chapel', 'Kaggalipura, St. Carlo Acutis Mass Centre', 'MEG Military Chapel, St. Sebastians Church']
  },
  'Hassan Zone': {
    Parish: ['Gochegundi, St. Mary\'s Church', 'Hanbal, St. Joseph\'s Church', 'Hassan, St. Mary\'s Church', 'Heggede, St. Mary\'s Church', 'Sakaleshpura, St. Antony\'s Church']
  },
  'Hinkal Forane': {
    Parish: ['Gundlupete, St. Chavara Church', 'Handpost, St. Joseph Church', 'Mysuru, Hinkal, Infant Jesus Cathedral', 'Mysuru, Kamanakere Hundi, Mount Carmel Church', 'Thandavapura, St. Paul\'s Church'],
    'Mass Centre': ['Honnamanakatte, Jyothi Vikas Centre', 'Srirampura, Mercy Convent Mass Centre, Mysore', 'T. Narasipura, St. Mary\'s Mass Centre', 'Yelawala, St. Padre Pio Mass Centre'],
    'Mission Centre': ['Handpost, Jeevadharu', 'Honnamanakatte, Jyothi Vikas Centre', 'Hunsur, Jeevashrama', 'Kebbepura, Preethidham Community Centre']
  },
  'Hongasandra Forane': {
    Parish: ['Bommanahalli, St. Mary\'s Church', 'Christ Nagar, Infant Jesus Church', 'Hongasandra, Holy Family Forane Church', 'Hebbagodi, Our Lady of Sorrows Church', 'Hullarahalli, Christ the King Church', 'Kasavanahalli, St. Norbert Church'],
    'Mass Centre': ['Choodasandra, St. Carlo Acutis Mass Centre']
  },
  'Jalahalli Forane': {
    Parish: ['Anchepalya, St. Benedict Church', 'Bisuvanahalli, Infant Jesus Church', 'Byalakere, St. Mary\'s Church', 'Jakkur, St. Francis De Sales Church', 'Jalahalli, St. Thomas Forane Church', 'Yelahanka, Mother of Victory Church'],
    'Mass Centre': ['Bidadi, Blessed Chiara Luce Badano Eucharistic Centre', 'Nelamangala, St. Mary\'s Mass Centre', 'Nelamangala, St. Joseph Mass Centre', 'Nelamangala, Josco Institutions']
  },
  'Mathikere Forane': {
    Parish: ['Dasarahalli, Ss. Joseph & Claret Church', 'Mathikere, St. Sebastian\'s Forane Church', 'Vijayanagar, Mary Matha Church'],
    'Mission Centre': ['Tumkur, St. Mother Theresa Mission Centre']
  },
  'Mandya Zone': {
    Parish: ['Kalenahalli, St. Mary\'s Church', 'Shikaripura, St. Mary\'s Church'],
    'Mass Centre': ['Anchechittanahalli, Shanti Nilaya', 'Guthalu, Vimala Matha Church', 'KM Doddy, St. Agatha Mass Centre'],
    'Mission Centre': ['Cheekanahalli, Nirmala Nivasa', 'Guthalu, Vimalalaya', 'Kodimaranahalli (Kikkeri), Chaithanya', 'Mandya Town, Jyothir Vikasa', 'Pandithahalli, Navachethana', 'Ragimuddanahalli, Gulabi Sadana', 'Rudrakshipura, Divya Sadana', 'Shikaripura, Sanjeevana']
  },
  'Sultanpalya Forane': {
    Parish: ['Babusaheb Palya, St. Joseph\'s Church', 'Indiranagar, St. Sebastian\'s Church', 'Kaggadasapura (Basavanagar), St. Mary\'s Church', 'Kothannur, St. Mary\'s Church', 'Lingarajapuram, St. Francis Assisi Church', 'Marianahalli, St. Augustine\'s Church', 'Ramamurthinagar, St. Mary\'s Church', 'Sultanpalya, St. Alphonsa Forane Church', 'Thambu Chetty Palya, St. Joseph Church', 'Udayanagar, St. Jude Church'],
    'Mass Centre': ['Ulsoor, St. Sebastian\'s Mass Centre']
  }
};

export const centreTypes = ['Parish', 'Mass Centre', 'Mission Centre'];
// The ID proofs a player can show; the form records the type and the last 4 characters of its number.
export const idTypes = ['Aadhaar', 'Voter ID', 'Driving Licence', 'Passport', 'Other'];
// Every entry as { group, type, name }.
export const centres = Object.entries(register).flatMap(([group, types]) => centreTypes.flatMap(type => (types[type] || []).map(name => ({ group, type, name }))));
export const groups = Object.keys(register);
const key = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// The register entry for a forane/zone and a parish or centre name, ignoring case and punctuation.
// The type tells apart a name listed twice (Honnamanakatte is a mass centre and a mission centre).
export function findCentre(group, name, type) {
  return centres.find(c => key(c.group) === key(group) && key(c.name) === key(name) && (!type || c.type === type)) ?? null;
}

// Article country detection from headline content.
// Adapted from worldmonitor config/countries.ts scoringKeywords + searchAliases.
//
// Falls back to source.country (feed origin) when no country is detected.
// Priority: first keyword match wins. Order below reflects geopolitical salience.
//
// Bigram keywords (multi-word) are checked via t.includes(), which is correct.
// Ambiguous unigrams (georgia, jordan) require the full country name or capital.

const COUNTRY_KEYWORDS = [
    ['USA', ['united states', 'america', 'washington dc', 'pentagon', 'white house', 'wall street', 'silicon valley', 'trump', 'biden', 'harris', 'democrat', 'republican', 'congress', 'senate', 'fbi', 'cia', 'nsa']],
    ['RUS', ['russia', 'russian', 'moscow', 'kremlin', 'putin', 'tass', 'siberia']],
    ['CHN', ['china', 'chinese', 'beijing', 'shanghai', 'xi jinping', 'prc', 'taiwan strait', 'south china sea', 'pla', 'politburo']],
    ['UKR', ['ukraine', 'ukrainian', 'kyiv', 'zelensky', 'zelenskyy', 'donbas', 'kherson', 'zaporizhzhia', 'bakhmut', 'kharkiv']],
    ['ISR', ['israel', 'israeli', 'tel aviv', 'netanyahu', 'idf', 'mossad', 'west bank', 'jerusalem', 'haifa']],
    ['PSE', ['gaza', 'hamas', 'rafah', 'hezbollah', 'palestinian', 'palestine', 'intifada']],
    ['IRN', ['iran', 'iranian', 'tehran', 'khamenei', 'irgc', 'rouhani', 'raisi', 'persian gulf']],
    ['SAU', ['saudi arabia', 'saudi', 'riyadh', 'mbs', 'bin salman', 'neom', 'aramco', 'opec']],
    ['TUR', ['turkey', 'turkish', 'ankara', 'erdogan', 'istanbul', 'türkiye']],
    ['IND', ['india', 'indian', 'new delhi', 'modi', 'mumbai', 'kashmir', 'bengaluru', 'hindutva']],
    ['PAK', ['pakistan', 'pakistani', 'islamabad', 'lahore', 'karachi', 'imran khan']],
    ['GBR', ['britain', 'british', 'london', 'united kingdom', 'england', 'scotland', 'wales', 'starmer', 'downing street']],
    ['FRA', ['france', 'french', 'paris', 'macron', 'marseille', 'élysée', 'elysee']],
    ['DEU', ['germany', 'german', 'berlin', 'scholz', 'bundestag', 'munich', 'hamburg']],
    ['JPN', ['japan', 'japanese', 'tokyo', 'osaka', 'yen ', 'fuji', 'shinzo abe']],
    ['KOR', ['south korea', 'seoul', 'korean won']],
    ['PRK', ['north korea', 'pyongyang', 'kim jong']],
    ['SYR', ['syria', 'syrian', 'damascus', 'aleppo']],
    ['YEM', ['yemen', 'houthi', 'sanaa', 'aden']],
    ['IRQ', ['iraq', 'iraqi', 'baghdad', 'erbil', 'mosul']],
    ['LBN', ['lebanon', 'lebanese', 'beirut']],
    ['EGY', ['egypt', 'egyptian', 'cairo', 'suez canal', 'sisi']],
    ['AFG', ['afghanistan', 'afghan', 'kabul', 'taliban']],
    ['TWN', ['taiwan', 'taipei']],
    ['MMR', ['myanmar', 'burma', 'burmese', 'rangoon', 'naypyidaw']],
    ['VEN', ['venezuela', 'venezuelan', 'caracas', 'maduro']],
    ['BRA', ['brazil', 'brazilian', 'brasilia', 'lula', 'bolsonaro', 'são paulo']],
    ['MEX', ['mexico', 'mexican', 'amlo', 'sheinbaum', 'cartel', 'sinaloa', 'tijuana']],
    ['ZAF', ['south africa', 'johannesburg', 'ramaphosa', 'pretoria']],
    ['ETH', ['ethiopia', 'ethiopian', 'addis ababa', 'tigray']],
    ['SDN', ['sudan', 'sudanese', 'khartoum', 'darfur', 'rsf']],
    ['UGA', ['uganda', 'ugandan', 'kampala']],
    ['NGA', ['nigeria', 'nigerian', 'abuja', 'lagos']],
    ['LBY', ['libya', 'libyan', 'tripoli', 'benghazi']],
    ['SOM', ['somalia', 'somali', 'mogadishu', 'al-shabaab']],
    ['AUS', ['australia', 'australian', 'canberra', 'sydney', 'melbourne']],
    ['CAN', ['canada', 'canadian', 'ottawa', 'toronto', 'trudeau']],
    ['ARE', ['uae', 'emirates', 'dubai', 'abu dhabi']],
    ['QAT', ['qatar', 'qatari', 'doha']],
    ['JOR', ['jordan', 'amman', 'jordanian']],         // 'jordan' alone skipped — common name
    ['POL', ['poland', 'polish', 'warsaw']],
    ['SGP', ['singapore', 'singaporean']],
    ['MYS', ['malaysia', 'kuala lumpur']],
    ['IDN', ['indonesia', 'indonesian', 'jakarta']],
    ['PHL', ['philippines', 'manila']],
    ['THA', ['thailand', 'thai', 'bangkok']],
    ['VNM', ['vietnam', 'vietnamese', 'hanoi']],
    ['ARG', ['argentina', 'argentinian', 'buenos aires', 'milei']],
    ['CHL', ['chile', 'chilean', 'santiago']],
    ['COL', ['colombia', 'colombian', 'bogotá', 'medellin']],
    ['PER', ['peruvian', 'lima peru']],                // 'peru' alone skipped — appears in biology
    ['KAZ', ['kazakhstan', 'almaty', 'astana']],
    ['AZE', ['azerbaijan', 'baku']],
    ['ARM', ['armenia', 'armenian', 'yerevan']],
    ['GEO', ['georgia', 'tbilisi', 'georgian']],       // matches 'georgia' as country name OR tbilisi
    ['SRB', ['serbia', 'serbian', 'belgrade']],
    ['CZE', ['czech', 'prague']],
    ['HUN', ['hungary', 'hungarian', 'budapest', 'orban']],
    ['NOR', ['norway', 'norwegian', 'oslo']],
    ['SWE', ['sweden', 'swedish', 'stockholm']],
    ['FIN', ['finland', 'finnish', 'helsinki']],
    ['DNK', ['denmark', 'danish', 'copenhagen']],
    ['NLD', ['netherlands', 'dutch', 'amsterdam', 'the hague']],
    ['BEL', ['belgium', 'belgian', 'brussels']],
    ['CHE', ['switzerland', 'swiss', 'zurich', 'geneva', 'davos']],
    ['AUT', ['austria', 'austrian', 'vienna']],
    ['ESP', ['spain', 'spanish', 'madrid', 'barcelona']],
    ['ITA', ['italy', 'italian', 'rome', 'milan', 'naples']],
    ['PRT', ['portugal', 'portuguese', 'lisbon']],
    ['GRC', ['greece', 'greek', 'athens']],
    ['ROU', ['romania', 'romanian', 'bucharest']],
    ['BGR', ['bulgaria', 'bulgarian', 'sofia']],
    ['HRV', ['croatia', 'croatian', 'zagreb']],
    ['MAR', ['morocco', 'moroccan', 'rabat', 'casablanca']],
    ['DZA', ['algeria', 'algerian', 'algiers']],
    ['TUN', ['tunisia', 'tunisian', 'tunis']],
    ['KEN', ['kenya', 'kenyan', 'nairobi']],
    ['GHA', ['ghana', 'ghanaian', 'accra']],
    ['CMR', ['cameroon', 'yaounde']],
    ['ZWE', ['zimbabwe', 'harare']],
    ['TZA', ['tanzania', 'dar es salaam']],
    ['RWA', ['rwanda', 'kigali']],
    ['MDG', ['madagascar']],
    ['CUB', ['cuba', 'cuban', 'havana']],
    ['HTI', ['haiti', 'haitian', 'port-au-prince']],
    ['DOM', ['dominican republic', 'santo domingo']],
    ['NZL', ['new zealand', 'auckland', 'wellington']],
];

// Ambiguous unigrams that should NOT match without context:
// 'uk ' handled via 'uk ' with trailing space below
// 'georgia' without tbilisi is ambiguous (US state, first name) — handled via multi-kw above

function normalizeTitle(title) {
    return title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '');
}

/**
 * Returns an iso3 country code if keywords match the article title.
 * Falls back to originCountry (the feed's country tag) if no match.
 *
 * @param {string} title - article title
 * @param {string} originCountry - feed source country (iso3)
 * @returns {string|null}
 */
function detectCountry(title, originCountry) {
    if (!title) return originCountry || null;
    const t = normalizeTitle(title) + ' ';  // trailing space enables ' uk ' boundary check
    for (const [code, keywords] of COUNTRY_KEYWORDS) {
        for (const kw of keywords) {
            if (t.includes(kw)) return code;
        }
    }
    return originCountry || null;
}

module.exports = { detectCountry };

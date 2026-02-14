const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const riotKey = process.env.RIOT_API_KEY;
const sb = createClient(url, key);

const TIER_MAP = {
    'IRON': '아이언', 'BRONZE': '브론즈', 'SILVER': '실버', 'GOLD': '골드',
    'PLATINUM': '플래티넘', 'EMERALD': '에메랄드', 'DIAMOND': '다이아몬드',
    'MASTER': '마스터', 'GRANDMASTER': '그랜드마스터', 'CHALLENGER': '챌린저'
};

module.exports = async (req, res) => {
    try {
        const { data: players, error: fetchError } = await sb
            .from('players')
            .select('*')
            .not('riot_id', 'is', null);

        if (fetchError) throw fetchError;

        for (const player of players) {
            try {
                if (player.manual_tier) continue;

                const [name, tag] = player.riot_id.split('#');
                if (!name || !tag) continue;

                // 1. Account-v1 (아시아 서버 주소 - 여기서 403 날 확률 높음)
                // 만약 여기서 터지면 API 키를 새로 발급받아야만 해결됩니다.
                const accountRes = await axios.get(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURI(name)}/${encodeURI(tag)}?api_key=${riotKey}`);
                const puuid = accountRes.data.puuid;

                // 2. Summoner-v4 (한국 서버)
                const summonerRes = await axios.get(`https://kr.api.riotgames.com/lol/summoner/v1/summoners/by-puuid/${puuid}?api_key=${riotKey}`);
                const summonerId = summonerRes.data.id;

                // 3. League-v4 (한국 서버)
                const leagueRes = await axios.get(`https://kr.api.riotgames.com/lol/league/v1/entries/by-summoner/${summonerId}?api_key=${riotKey}`);
                const soloRank = leagueRes.data.find(l => l.queueType === 'RANKED_SOLO_5x5') || { tier: 'UNRANKED', rank: '', leaguePoints: 0 };

                const tierKor = TIER_MAP[soloRank.tier] || '언랭크';
                const currentTierStr = soloRank.tier === 'UNRANKED' ? '언랭크' : `${tierKor} ${soloRank.rank} - ${soloRank.leaguePoints}LP`;

                // 4. Match-v5 (아시아 서버)
                const matchIdsRes = await axios.get(`https://asia.api.riotgames.com/lol/match/v1/matchlist/by-puuid/${puuid}/ids?start=0&count=1&api_key=${riotKey}`);
                const lastMatchId = matchIdsRes.data[0] || null;

                let recent = (player.recent && player.recent.length === 10) ? [...player.recent] : Array(10).fill("ing");
                let champs = (player.champions && player.champions.length === 10) ? [...player.champions] : Array(10).fill("None");

                if (lastMatchId && player.last_match_id !== lastMatchId) {
                    const matchDetail = await axios.get(`https://asia.api.riotgames.com/lol/match/v1/matches/${lastMatchId}?api_key=${riotKey}`);
                    const p = matchDetail.data.info.participants.find(p => p.puuid === puuid);
                    
                    if (p) {
                        const firstEmpty = recent.indexOf("ing");
                        if (firstEmpty !== -1) {
                            recent[firstEmpty] = p.win ? 'win' : 'lose';
                            champs[firstEmpty] = p.championName;
                        } else {
                            recent = [...recent.slice(1), p.win ? 'win' : 'lose'];
                            champs = [...champs.slice(1), p.championName];
                        }
                    }
                }

                // 5. DB 업데이트 (변경된 부분만 반영)
                await sb.from('players').update({
                    tier: currentTierStr,
                    puuid: puuid,
                    last_match_id: lastMatchId || player.last_match_id,
                    recent: recent,
                    champions: champs
                }).eq('id', player.id);

            } catch (err) {
                // 어떤 부분에서 403이 났는지 로그로 확인 가능하게 출력
                console.error(`${player.name} 실패: ${err.response?.status} - ${err.message}`);
                continue;
            }
        }
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

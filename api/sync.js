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
        if (!url || !key || !riotKey) {
            return res.status(500).json({ success: false, error: "환경변수 설정 확인 필요" });
        }

        const { data: players, error: fetchError } = await sb
            .from('players')
            .select('*')
            .not('riot_id', 'is', null);

        if (fetchError) throw fetchError;

        for (const player of players) {
            try {
                if (player.manual_tier) continue;

                const parts = player.riot_id.split('#');
                if (parts.length < 2) continue;
                const name = parts[0];
                const tag = parts[1];

                // 라이엇 계정 조회
                const accountRes = await axios.get(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURI(name)}/${encodeURI(tag)}?api_key=${riotKey}`);
                const puuid = accountRes.data.puuid;

                // 소환사 ID 조회
                const summonerRes = await axios.get(`https://kr.api.riotgames.com/lol/summoner/v1/summoners/by-puuid/${puuid}?api_key=${riotKey}`);
                const summonerId = summonerRes.data.id;

                // 리그 정보 조회
                const leagueRes = await axios.get(`https://kr.api.riotgames.com/lol/league/v1/entries/by-summoner/${summonerId}?api_key=${riotKey}`);
                const soloRank = leagueRes.data.find(l => l.queueType === 'RANKED_SOLO_5x5') || { tier: 'UNRANKED', rank: '', leaguePoints: 0 };

                const tierKor = TIER_MAP[soloRank.tier] || '언랭크';
                const currentTierStr = soloRank.tier === 'UNRANKED' ? '언랭크' : `${tierKor} ${soloRank.rank} - ${soloRank.leaguePoints}LP`;

                // 전적 ID 조회 (최근 1게임)
                const matchIdsRes = await axios.get(`https://asia.api.riotgames.com/lol/match/v1/matchlist/by-puuid/${puuid}/ids?start=0&count=1&api_key=${riotKey}`);
                const lastMatchId = matchIdsRes.data[0] || null;

                let recent = (player.recent && player.recent.length === 10) ? [...player.recent] : Array(10).fill("ing");
                let champs = (player.champions && player.champions.length === 10) ? [...player.champions] : Array(10).fill("None");
                let lpDiffText = player.lp_diff || "";

                // 전적이 있고, 기존 기록과 다를 때만 업데이트
                if (lastMatchId && player.last_match_id !== lastMatchId) {
                    const matchDetail = await axios.get(`https://asia.api.riotgames.com/lol/match/v1/matches/${lastMatchId}?api_key=${riotKey}`);
                    const participant = matchDetail.data.info.participants.find(p => p.puuid === puuid);
                    
                    if (participant) {
                        // 티어 변동 체크
                        if (player.tier && player.tier !== currentTierStr) {
                             lpDiffText = `티어/점수 변동 감지`;
                        }

                        // 배열 채우기 (빈자리 있으면 채우고 없으면 밀기)
                        const firstEmpty = recent.indexOf("ing");
                        if (firstEmpty !== -1) {
                            recent[firstEmpty] = participant.win ? 'win' : 'lose';
                            champs[firstEmpty] = participant.championName;
                        } else {
                            recent = [...recent.slice(1), participant.win ? 'win' : 'lose'];
                            champs = [...champs.slice(1), participant.championName];
                        }
                    }
                }

                // DB 업데이트
                await sb.from('players').update({
                    tier: currentTierStr,
                    puuid: puuid,
                    last_match_id: lastMatchId || player.last_match_id,
                    recent: recent,
                    champions: champs,
                    lp_diff: lpDiffText,
                    updated_at: new Date().toISOString()
                }).eq('id', player.id);

            } catch (err) {
                console.error(`${player.name} 스킵: `, err.message);
                // 개별 플레이어 에러나도 멈추지 않고 다음 플레이어로 진행
                continue; 
            }
        }
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// 1. 환경 변수 설정 (Vercel 설정에 맞게 자동 선택)
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const riotKey = process.env.RIOT_API_KEY;
const sb = createClient(url, key);

// 티어 한글 변환 맵
const TIER_MAP = {
    'IRON': '아이언', 'BRONZE': '브론즈', 'SILVER': '실버', 'GOLD': '골드',
    'PLATINUM': '플래티넘', 'EMERALD': '에메랄드', 'DIAMOND': '다이아몬드',
    'MASTER': '마스터', 'GRANDMASTER': '그랜드마스터', 'CHALLENGER': '챌린저'
};

module.exports = async (req, res) => {
    try {
        // 2. 플레이어 목록 가져오기 (라이엇 ID가 있는 사람만)
        const { data: players, error: fetchError } = await sb
            .from('players')
            .select('*')
            .not('riot_id', 'is', null);

        if (fetchError) throw fetchError;

        for (const player of players) {
            try {
                // 수동 티어 고정 모드면 스킵
                if (player.manual_tier) continue;

                const [name, tag] = player.riot_id.split('#');
                if (!name || !tag) continue;

                // 3. 라이엇 API 호출 (PUUID -> ID -> League 순서)
                const accountRes = await axios.get(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURI(name)}/${encodeURI(tag)}?api_key=${riotKey}`);
                const puuid = accountRes.data.puuid;

                const summonerRes = await axios.get(`https://kr.api.riotgames.com/lol/summoner/v1/summoners/by-puuid/${puuid}?api_key=${riotKey}`);
                const summonerId = summonerRes.data.id;

                const leagueRes = await axios.get(`https://kr.api.riotgames.com/lol/league/v1/entries/by-summoner/${summonerId}?api_key=${riotKey}`);
                const soloRank = leagueRes.data.find(l => l.queueType === 'RANKED_SOLO_5x5') || { tier: 'UNRANKED', rank: '', leaguePoints: 0 };

                // 티어 문자열 생성 (예: 골드 4 - 25LP)
                const tierKor = TIER_MAP[soloRank.tier] || '언랭크';
                const rankNum = soloRank.rank || '';
                const currentTierStr = soloRank.tier === 'UNRANKED' ? '언랭크' : `${tierKor} ${rankNum} - ${soloRank.leaguePoints}LP`;

                // 4. 최근 전적 1판 정보 가져오기
                const matchIdsRes = await axios.get(`https://asia.api.riotgames.com/lol/match/v1/matchlist/by-puuid/${puuid}/ids?start=0&count=1&api_key=${riotKey}`);
                const lastMatchId = matchIdsRes.data[0];

                let matchStats = { win: null, champion: 'None' };
                if (lastMatchId) {
                    const matchDetail = await axios.get(`https://asia.api.riotgames.com/lol/match/v1/matches/${lastMatchId}?api_key=${riotKey}`);
                    const participant = matchDetail.data.info.participants.find(p => p.puuid === puuid);
                    matchStats.win = participant.win;
                    matchStats.champion = participant.championName;
                }

                // 5. [핵심] 전적 배열(Recent) 관리 로직
                let recent = (player.recent && player.recent.length === 10) ? [...player.recent] : Array(10).fill("ing");
                let champs = (player.champions && player.champions.length === 10) ? [...player.champions] : Array(10).fill("None");
                let lpDiffText = player.lp_diff || "";

                // 새 게임이 감지되었을 때만 로직 실행
                if (lastMatchId && player.last_match_id !== lastMatchId) {
                    // 승급/승격/강등 감지 (간단 로직)
                    if (player.tier && player.tier !== currentTierStr) {
                        const oldLP = parseInt(player.tier.match(/\d+/) || [0]);
                        const newLP = soloRank.leaguePoints;
                        
                        if (player.tier.split(' ')[0] !== tierKor) {
                             lpDiffText = `✨ 티어 변동!`;
                        } else {
                             const diff = newLP - oldLP;
                             lpDiffText = diff >= 0 ? `📈 +${diff}LP` : `📉 ${diff}LP`;
                        }
                    }

                    // 빈자리(ing)가 있으면 앞에서부터 채우고, 꽉 찼으면 밀어내기
                    const firstEmptyIndex = recent.indexOf("ing");
                    if (firstEmptyIndex !== -1) {
                        // 빈칸이 있으면 그 자리에 채움
                        recent[firstEmptyIndex] = matchStats.win ? 'win' : 'lose';
                        champs[firstEmptyIndex] = matchStats.champion;
                    } else {
                        // 꽉 찼으면 왼쪽으로 밀고 맨 뒤에 추가
                        recent = [...recent.slice(1), matchStats.win ? 'win' : 'lose'];
                        champs = [...champs.slice(1), matchStats.champion];
                    }
                }

                // 6. DB 업데이트 (최적화된 단일 업데이트)
                await sb.from('players').update({
                    tier: currentTierStr,
                    puuid: puuid,
                    last_match_id: lastMatchId,
                    recent: recent,
                    champions: champs,
                    lp_diff: lpDiffText,
                    updated_at: new Date().toISOString()
                }).eq('id', player.id);

            } catch (playerError) {
                console.error(`${player.name} 업데이트 실패:`, playerError.message);
            }
        }

        res.status(200).json({ success: true, message: "전적 동기화 완료" });
    } catch (error) {
        console.error("서버 에러:", error);
        res.status(500).json({ success: false, error: error.message });
    }
};

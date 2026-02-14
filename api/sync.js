const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

module.exports = async (req, res) => {
    // 환경 변수 로드 (Vercel Settings에서 설정한 이름과 일치해야 함)
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const riotApiKey = process.env.RIOT_API_KEY;

    // 티어 한글 매핑 데이터
    const T_KO = {
        'IRON': '아이언', 'BRONZE': '브론즈', 'SILVER': '실버', 'GOLD': '골드', 
        'PLATINUM': '플래티넘', 'EMERALD': '에메랄드', 'DIAMOND': '다이아몬드', 
        'MASTER': '마스터', 'GRANDMASTER': '그랜드마스터', 'CHALLENGER': '챌린저'
    };
    const R_KO = { 'IV': '4', 'III': '3', 'II': '2', 'I': '1' };

    // 점수 계산용 순서
    const T_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
    const R_ORDER = ['IV', 'III', 'II', 'I'];

    try {
        // 1. DB에서 모든 플레이어 정보 한 번에 가져오기
        const { data: players, error: dbError } = await supabase.from('players').select('*');
        if (dbError) throw dbError;

        const updateData = []; 

        for (const player of players) {
            if (player.manual_tier || !player.riot_id?.includes('#')) continue;
            
            const [name, tag] = player.riot_id.split('#');

            // [Riot API] PUUID 및 리그 정보 조회
            const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotApiKey}`);
            if (!accRes.ok) continue;
            const account = await accRes.json();

            const matchIdRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=0&count=1&api_key=${riotApiKey}`);
            const matchIds = await matchIdRes.json();
            const currentMatchId = matchIds[0];

            const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}?api_key=${riotApiKey}`);
            const leagues = await leagueRes.json();
            const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');

            if (!solo) continue;

            // 티어 한글화 처리
            const tierKo = T_KO[solo.tier.toUpperCase()] || solo.tier;
            const rankKo = R_KO[solo.rank] || ""; 
            const fullTierKo = rankKo ? `${tierKo} ${rankKo}` : tierKo; 

            let lpDiffText = "";
            let shouldTrigger = false;
            let matchStats = null;

            // 누적 LP 계산 함수
            const getAbsoluteLP = (t, r, lp) => {
                // 한글 티어명을 다시 영문 인덱스로 찾기 위해 역매핑 혹은 변환 필요
                // 여기서는 라이엇 API에서 온 원본 영문 데이터(solo.tier)를 기준으로 계산 로직에 활용
                const tIdx = T_ORDER.indexOf(t.toUpperCase());
                const lpVal = parseInt(lp) || 0;
                if (tIdx >= T_ORDER.indexOf('MASTER')) return 2800 + lpVal;
                const rIdx = R_ORDER.indexOf(r?.toUpperCase() || "IV");
                return (tIdx * 400) + (rIdx * 100) + lpVal;
            };

            // 게임 종료 감지
            if (currentMatchId && currentMatchId !== player.last_match_id) {
                const detailRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotApiKey}`);
                const detail = await detailRes.json();
                const me = detail.info.participants.find(p => p.puuid === account.puuid);

                if (me) {
                    shouldTrigger = true;
                    // 한글/영문 모두 대응하는 정규식
                    const tierMatch = player.tier.match(/([A-Z\s가-힣]+)\s?([0-9I|V|X]+)?\s?-\s?(\d+)LP/);
                    
                    if (tierMatch) {
                        // 기존 DB의 한글 티어를 다시 영문으로 돌려 점수 계산 (비교용)
                        const oldTierKo = tierMatch[1].trim();
                        const oldTierEng = Object.keys(T_KO).find(key => T_KO[key] === oldTierKo) || oldTierKo;
                        const oldRankNum = tierMatch[2] ? tierMatch[2].trim() : "I";
                        const oldRankEng = Object.keys(R_KO).find(key => R_KO[key] === oldRankNum) || oldRankNum;
                        const oldLP = tierMatch[3];

                        const oldAbsLP = getAbsoluteLP(oldTierEng, oldRankEng, oldLP);
                        const newAbsLP = getAbsoluteLP(solo.tier, solo.rank || "I", solo.leaguePoints);
                        const diff = newAbsLP - oldAbsLP;

                        const isTierChanged = oldTierEng.toUpperCase() !== solo.tier.toUpperCase();
                        const isRankChanged = !isTierChanged && oldRankEng !== (solo.rank || "I");

                        if (isTierChanged) {
                            lpDiffText = `${diff > 0 ? "✨ 승격!" : "↘️ 강등"} (${diff > 0 ? '+' : ''}${diff}LP)`;
                        } else if (isRankChanged) {
                            lpDiffText = `${diff > 0 ? "↗️ 승급!" : "↘️ 하락"} (${diff > 0 ? '+' : ''}${diff}LP)`;
                        } else {
                            lpDiffText = diff >= 0 ? `(+${diff}LP)` : `(${diff}LP)`;
                        }
                    }

                    matchStats = {
                        kda: `${me.kills}/${me.deaths}/${me.assists}`,
                        champion: me.championName,
                        win: me.win,
                        lpDiff: lpDiffText
                    };
                }
            }

            updateData.push({
                id: player.id,
                tier: `${fullTierKo} - ${solo.leaguePoints}LP`, // 한글로 저장
                last_match_id: currentMatchId,
                last_kda: matchStats ? matchStats.kda : player.last_kda,
                lp_diff: matchStats ? matchStats.lpDiff : player.lp_diff,
                recent: shouldTrigger ? [...(player.recent || []).slice(1), matchStats.win ? 'win' : 'lose'] : player.recent,
                champions: shouldTrigger ? [...(player.champions || []).slice(1), matchStats.champion] : player.champions,
                wins: (shouldTrigger && matchStats.win) ? (player.wins + 1) : player.wins,
                losses: (shouldTrigger && !matchStats.win) ? (player.losses + 1) : player.losses,
                trigger_cutscene: shouldTrigger,
                puuid: account.puuid
            });
        }

        // 일괄 업데이트
        if (updateData.length > 0) {
            const { error: upsertError } = await supabase.from('players').upsert(updateData);
            if (upsertError) throw upsertError;
        }

        return res.status(200).json({ success: true, count: updateData.length });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

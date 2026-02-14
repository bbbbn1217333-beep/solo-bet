const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

module.exports = async (req, res) => {
    // 1. 환경 변수 체크 (비어있으면 에러 반환)
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    const riotKey = process.env.RIOT_API_KEY;

    if (!url || !key || !riotKey) {
        return res.status(500).json({ success: false, error: "환경 변수(URL/KEY/RIOT)가 설정되지 않았습니다." });
    }

    const supabase = createClient(url, key);

    const T_KO = { 'IRON': '아이언', 'BRONZE': '브론즈', 'SILVER': '실버', 'GOLD': '골드', 'PLATINUM': '플래티넘', 'EMERALD': '에메랄드', 'DIAMOND': '다이아몬드', 'MASTER': '마스터', 'GRANDMASTER': '그랜드마스터', 'CHALLENGER': '챌린저' };
    const R_KO = { 'IV': '4', 'III': '3', 'II': '2', 'I': '1' };
    const T_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
    const R_ORDER = ['IV', 'III', 'II', 'I'];

    try {
        const { data: players, error: dbError } = await supabase.from('players').select('*');
        if (dbError) throw dbError;

        const updateData = []; 

        for (const player of players) {
            if (player.manual_tier || !player.riot_id?.includes('#')) continue;
            
            const [name, tag] = player.riot_id.split('#');
            const accRes = await fetch(`https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}?api_key=${riotKey}`);
            if (!accRes.ok) continue;
            const account = await accRes.json();

            const matchIdRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=0&count=1&api_key=${riotKey}`);
            const matchIds = await matchIdRes.json();
            const currentMatchId = matchIds[0];

            const leagueRes = await fetch(`https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}?api_key=${riotKey}`);
            const leagues = await leagueRes.json();
            const solo = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5');

            if (!solo) continue;

            const tierKo = T_KO[solo.tier.toUpperCase()] || solo.tier;
            const rankKo = R_KO[solo.rank] || ""; 
            const fullTierKo = rankKo ? `${tierKo} ${rankKo}` : tierKo; 

            let lpDiffText = "";
            let shouldTrigger = false;
            let matchStats = null;

            const getAbsoluteLP = (t, r, lp) => {
                const tIdx = T_ORDER.indexOf(t.toUpperCase());
                if (tIdx === -1) return 0; // 티어를 못 찾으면 0 반환
                const lpVal = parseInt(lp) || 0;
                if (tIdx >= T_ORDER.indexOf('MASTER')) return 2800 + lpVal;
                const rIdx = R_ORDER.indexOf(r?.toUpperCase() || "IV");
                return (tIdx * 400) + (rIdx * 100) + lpVal;
            };

            if (currentMatchId && currentMatchId !== player.last_match_id) {
                const detailRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotKey}`);
                const detail = await detailRes.json();
                const me = detail.info.participants?.find(p => p.puuid === account.puuid);

                if (me) {
                    shouldTrigger = true;
                    // 한글/영문/단계 유무 상관없이 매칭되도록 보강
                    const tierMatch = (player.tier || "").match(/([A-Z\s가-힣]+)\s?([0-9I|V|X]+)?\s?-\s?(\d+)LP/);
                    
                    if (tierMatch) {
                        const oldTierKo = tierMatch[1].trim();
                        const oldTierEng = Object.keys(T_KO).find(key => T_KO[key] === oldTierKo) || oldTierKo;
                        const oldRankNum = tierMatch[2] ? tierMatch[2].trim() : "I";
                        // 한글 숫자(1,2,3,4)를 로마자(I, II..)로 역변환
                        const oldRankEng = Object.keys(R_KO).find(key => R_KO[key] === oldRankNum) || oldRankNum;
                        
                        const oldAbsLP = getAbsoluteLP(oldTierEng, oldRankEng, tierMatch[3]);
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
                tier: `${fullTierKo} - ${solo.leaguePoints}LP`,
                last_match_id: currentMatchId,
                last_kda: matchStats ? matchStats.kda : (player.last_kda || "0/0/0"),
                lp_diff: matchStats ? matchStats.lpDiff : (player.lp_diff || ""),
                recent: (shouldTrigger && matchStats) ? [...(player.recent || ["none","none","none","none","none"]).slice(1), matchStats.win ? 'win' : 'lose'] : (player.recent || ["none","none","none","none","none"]),
                champions: (shouldTrigger && matchStats) ? [...(player.champions || ["None","None","None","None","None"]).slice(1), matchStats.champion] : (player.champions || ["None","None","None","None","None"]),
                wins: (shouldTrigger && matchStats?.win) ? (player.wins + 1) : player.wins,
                losses: (shouldTrigger && matchStats && !matchStats.win) ? (player.losses + 1) : player.losses,
                trigger_cutscene: shouldTrigger,
                puuid: account.puuid
            });
        }

        if (updateData.length > 0) {
            const { error: upsertError } = await supabase.from('players').upsert(updateData);
            if (upsertError) throw upsertError;
        }

        return res.status(200).json({ success: true, count: updateData.length });
    } catch (error) {
        // 500 에러 시 원인을 구체적으로 출력
        return res.status(500).json({ success: false, error: error.message, stack: error.stack });
    }
};

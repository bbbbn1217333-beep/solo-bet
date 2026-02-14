const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

module.exports = async (req, res) => {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const riotApiKey = process.env.RIOT_API_KEY;

    // 티어 순서 정의 (승급 계산용)
    const TIER_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'EMERALD', 'PLATINUM', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
    const RANK_ORDER = ['IV', 'III', 'II', 'I'];

    try {
        const { data: players } = await supabase.from('players').select('*');
        const updateData = [];

        for (const player of players) {
            if (player.manual_tier || !player.riot_id?.includes('#')) continue;
            const [name, tag] = player.riot_id.split('#');

            // 1. 라이엇 데이터 호출 (PUUID -> MatchId -> League 순서)
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

            // 2. 승급/강등 및 점수 변동 계산
            let lpDiffText = "";
            let shouldTrigger = false;
            let matchStats = null;

            // 새 게임 종료가 감지되었을 때만 계산
            if (currentMatchId && currentMatchId !== player.last_match_id) {
                const detailRes = await fetch(`https://asia.api.riotgames.com/lol/match/v5/matches/${currentMatchId}?api_key=${riotApiKey}`);
                const detail = await detailRes.json();
                const me = detail.info.participants.find(p => p.puuid === account.puuid);

                if (me) {
                    shouldTrigger = true;
                    
                    // 기존 데이터 파싱 (예: "GOLD I - 50LP")
                    const tierMatch = player.tier.match(/([A-Z]+)\s([I|V|X]+)\s-\s(\d+)LP/);
                    if (tierMatch) {
                        const oldTier = tierMatch[1];
                        const oldRank = tierMatch[2];
                        const oldLP = parseInt(tierMatch[3]);

                        // 티어 자체가 바뀌었는지 확인
                        if (oldTier !== solo.tier) {
                            const isUp = TIER_ORDER.indexOf(solo.tier) > TIER_ORDER.indexOf(oldTier);
                            lpDiffText = isUp ? "✨ TIER UP! ✨" : "💢 TIER DOWN";
                        } 
                        // 같은 티어 내에서 단계(I, II..)가 바뀌었는지 확인
                        else if (oldRank !== solo.rank) {
                            const isUp = RANK_ORDER.indexOf(solo.rank) > RANK_ORDER.indexOf(oldRank);
                            lpDiffText = isUp ? "↗️ RANK UP!" : "↘️ RANK DOWN";
                        } 
                        // 단계도 같으면 LP 차이 계산
                        else {
                            const diff = solo.leaguePoints - oldLP;
                            lpDiffText = diff >= 0 ? `(+${diff}LP)` : `(${diff}LP)`;
                        }
                    } else {
                        lpDiffText = "(전적갱신)";
                    }

                    matchStats = {
                        kda: `${me.kills}/${me.deaths}/${me.assists}`,
                        champion: me.championName,
                        win: me.win,
                        lpDiff: lpDiffText
                    };
                }
            }

            // 3. DB 업데이트 데이터 생성
            updateData.push({
                id: player.id,
                tier: `${solo.tier} ${solo.rank} - ${solo.leaguePoints}LP`,
                last_match_id: currentMatchId,
                last_kda: matchStats ? matchStats.kda : player.last_kda,
                recent: shouldTrigger ? [...(player.recent || []).slice(1), matchStats.win ? 'win' : 'lose'] : player.recent,
                champions: shouldTrigger ? [...(player.champions || []).slice(1), matchStats.champion] : player.champions,
                wins: (shouldTrigger && matchStats.win) ? (player.wins + 1) : player.wins,
                losses: (shouldTrigger && !matchStats.win) ? (player.losses + 1) : player.losses,
                trigger_cutscene: shouldTrigger,
                puuid: account.puuid
            });
        }

        if (updateData.length > 0) {
            await supabase.from('players').upsert(updateData);
        }

        return res.status(200).json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};
